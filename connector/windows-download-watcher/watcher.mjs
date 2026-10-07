import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const baseDir = path.join(process.env.LOCALAPPDATA || os.homedir(), "CSTFleetWatcher");
const configPath = path.join(baseDir, "config.json");
const logPath = path.join(baseDir, "watcher.log");
const downloadDir = path.join(os.homedir(), "Downloads");

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { fs.appendFileSync(logPath, line + "\r\n", "utf8"); } catch {}
}

function decryptDpapi(ciphertext) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$enc=[Console]::In.ReadToEnd()",
    "$sec=ConvertTo-SecureString $enc",
    "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)",
    "try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}"
  ].join(";");
  const out = spawnSync("powershell.exe", ["-NoProfile","-NonInteractive","-Command",script], {
    input: ciphertext, encoding:"utf8", windowsHide:true
  });
  if (out.status !== 0) throw new Error("Gagal membuka secret lokal.");
  return String(out.stdout || "");
}

if (!fs.existsSync(configPath)) {
  throw new Error("Watcher belum di-install. Jalankan INSTALL.bat terlebih dahulu.");
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const sharedSecret = decryptDpapi(config.sharedSecretProtected);
const fleetBaseUrl = String(config.fleetBaseUrl || "https://fleet.cstlogistic.co.id").replace(/\/$/,"");
const portalUrl = String(config.portalUrl || "https://fleetpartner.gojek.com");
const controlPort = Number(config.controlPort || 17891);
const state = {
  version: "final-1",
  startedAt: new Date().toISOString(),
  lastScanAt: null,
  lastDetectedFile: null,
  lastImportAt: null,
  lastImportFile: null,
  lastImportType: null,
  lastError: null,
  successfulImports: 0,
  failedImports: 0,
};

const seen = new Map();
const pending = new Map();
const startupCutoff = Date.now() - 10 * 60 * 1000;
for (const name of fs.readdirSync(downloadDir)) {
  if (!name.toLowerCase().endsWith(".csv")) continue;
  const p = path.join(downloadDir,name);
  try {
    const st = fs.statSync(p);
    seen.set(p, st.mtimeMs);
    if (st.mtimeMs >= startupCutoff) {
      pending.set(p,{size:st.size,stable:0,busy:false,mtime:st.mtimeMs});
    }
  } catch {}
}

async function handoff(filePath) {
  const content = fs.readFileSync(filePath,"utf8");
  state.lastDetectedFile = path.basename(filePath);
  const fileName = path.basename(filePath);
  const response = await fetch(`${fleetBaseUrl}/api/logistics/fleet/gojek-connector/handoff`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-gojek-connector-secret": sharedSecret,
    },
    body:JSON.stringify({fileName,content}),
    signal:AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(()=>({}));
  if (response.ok) {
    state.successfulImports += 1;
    state.lastImportAt = new Date().toISOString();
    state.lastImportFile = fileName;
    state.lastImportType = payload.exportType || payload.type || "unknown";
    state.lastError = null;
    log(`IMPORT OK ${fileName} type=${state.lastImportType}`);
    fs.rmSync(filePath,{force:true});
    return;
  }
  const msg=String(payload.error || `HTTP ${response.status}`);
  if (response.status===409 && /sudah pernah|duplikat/i.test(msg)) {
    log(`DUPLICATE ${fileName}: ${msg}`);
    fs.rmSync(filePath,{force:true});
    return;
  }
  throw new Error(msg);
}

setInterval(() => {
  state.lastScanAt = new Date().toISOString();
  let names=[];
  try { names=fs.readdirSync(downloadDir); } catch { return; }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".csv")) continue;
    const p=path.join(downloadDir,name);
    let st; try { st=fs.statSync(p); } catch { continue; }
    const prior=seen.get(p);
    const cur=pending.get(p) || {size:-1,stable:0,busy:false,mtime:0};
    if (cur.busy) continue;

    // New/changed CSV enters the pending queue. Subsequent polls must keep
    // checking its size even when mtime is unchanged so we can confirm the
    // browser has finished writing it.
    if (prior === undefined || prior !== st.mtimeMs) {
      seen.set(p,st.mtimeMs);
      cur.mtime=st.mtimeMs;
      cur.size=st.size;
      cur.stable=0;
      pending.set(p,cur);
      continue;
    }

    if (!pending.has(p)) continue;
    if (cur.size===st.size) cur.stable+=1;
    else { cur.size=st.size; cur.stable=0; }
    pending.set(p,cur);
    if (cur.stable < 2) continue;
    cur.busy=true;
    void handoff(p).then(()=>pending.delete(p)).catch((e)=>{
      state.failedImports += 1;
      state.lastError = e instanceof Error ? e.message : String(e);
      log(`IMPORT FAIL ${name}: ${state.lastError}`);
      cur.busy=false; cur.stable=0;
    });
  }
},2000);

const server=http.createServer(async (req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","https://fleet.cstlogistic.co.id");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Cache-Control","no-store");
  if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
  if(req.method==="GET"&&req.url==="/health"){
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true,watcher:"cst-fleet-download-watcher",version:state.version,downloadDir,...state}));
    return;
  }
  if(req.method==="POST"&&req.url==="/self-test"){
    const probePath = path.join(downloadDir,".cst-fleet-watcher-probe");
    try {
      fs.writeFileSync(probePath,"probe","utf8");
      fs.rmSync(probePath,{force:true});

      const sample = [
        "Driver Name,Phone Number,License Plate,Rental fee (Daily),Outstanding,Status",
        "SELF TEST,628123456789,B1234XYZ,5000,10000,Active"
      ].join("\n");

      const response = await fetch(`${fleetBaseUrl}/api/logistics/fleet/gojek-connector/dry-run`, {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-gojek-connector-secret": sharedSecret,
        },
        body:JSON.stringify({fileName:"watcher-self-test.csv",content:sample}),
        signal:AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({
        ok:true,
        watcherVersion:state.version,
        downloadDir,
        downloadWritable:true,
        serverAuthenticated:true,
        database:payload.database,
        parserType:payload.exportType,
        parserRows:payload.rowCount,
        persisted:payload.persisted,
      }));
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      state.lastError=message;
      res.writeHead(500,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false,error:message,watcherVersion:state.version,downloadDir}));
    }
    return;
  }

  if(req.method==="POST"&&req.url==="/open"){
    spawn("cmd.exe",["/c","start","",portalUrl],{detached:true,windowsHide:true,stdio:"ignore"}).unref();
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true}));return;
  }
  res.writeHead(404);res.end();
});
server.listen(controlPort,"127.0.0.1",()=>{
  try { fs.writeFileSync(path.join(baseDir,"watcher.pid"),String(process.pid),"utf8"); } catch {}
  log(`Watcher ${state.version} aktif pid=${process.pid} di 127.0.0.1:${controlPort}; folder=${downloadDir}`);
});
