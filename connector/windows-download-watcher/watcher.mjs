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

const seen = new Map();
for (const name of fs.readdirSync(downloadDir)) {
  if (!name.toLowerCase().endsWith(".csv")) continue;
  const p = path.join(downloadDir,name);
  try { seen.set(p, fs.statSync(p).mtimeMs); } catch {}
}

async function handoff(filePath) {
  const content = fs.readFileSync(filePath,"utf8");
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
    log(`IMPORT OK ${fileName} type=${payload.exportType || payload.type || "unknown"}`);
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

const pending = new Map();
setInterval(() => {
  let names=[];
  try { names=fs.readdirSync(downloadDir); } catch { return; }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".csv")) continue;
    const p=path.join(downloadDir,name);
    let st; try { st=fs.statSync(p); } catch { continue; }
    const prior=seen.get(p);
    if (prior !== undefined && prior === st.mtimeMs) continue;
    seen.set(p,st.mtimeMs);
    const cur=pending.get(p) || {size:-1,stable:0,busy:false};
    if (cur.busy) continue;
    if (cur.size===st.size) cur.stable+=1; else {cur.size=st.size;cur.stable=0;}
    pending.set(p,cur);
    if (cur.stable < 2) continue;
    cur.busy=true;
    void handoff(p).then(()=>pending.delete(p)).catch((e)=>{
      log(`IMPORT FAIL ${name}: ${e instanceof Error?e.message:String(e)}`);
      cur.busy=false; cur.stable=0;
    });
  }
},2000);

const server=http.createServer((req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","https://fleet.cstlogistic.co.id");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Cache-Control","no-store");
  if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
  if(req.method==="GET"&&req.url==="/health"){
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true,watcher:"cst-fleet-download-watcher",downloadDir}));
    return;
  }
  if(req.method==="POST"&&req.url==="/open"){
    spawn("cmd.exe",["/c","start","",portalUrl],{detached:true,windowsHide:true,stdio:"ignore"}).unref();
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true}));return;
  }
  res.writeHead(404);res.end();
});
server.listen(controlPort,"127.0.0.1",()=>log(`Watcher aktif di 127.0.0.1:${controlPort}; folder=${downloadDir}`));
