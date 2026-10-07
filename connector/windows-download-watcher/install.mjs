import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, spawn } from "node:child_process";
import readline from "node:readline";

const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const target=path.join(process.env.LOCALAPPDATA || os.homedir(),"CSTFleetWatcher");
fs.mkdirSync(target,{recursive:true});

function stopExistingWatcher() {
  const pidPath=path.join(target,"watcher.pid");
  if (fs.existsSync(pidPath)) {
    const pid=Number(fs.readFileSync(pidPath,"utf8").trim());
    if (Number.isInteger(pid) && pid>0) {
      spawnSync("taskkill",["/PID",String(pid),"/F"],{windowsHide:true,stdio:"ignore"});
    }
    try { fs.rmSync(pidPath,{force:true}); } catch {}
  }

  // Compatibility with v1/v2, which did not create watcher.pid.
  // Port 17891 is reserved for the CST Fleet watcher local control endpoint.
  const net=spawnSync("cmd.exe",["/c","netstat -ano -p tcp | findstr LISTENING | findstr :17891"],{
    encoding:"utf8",windowsHide:true
  });
  const lines=String(net.stdout||"").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match=line.trim().match(/\s(\d+)$/);
    const pid=match ? Number(match[1]) : 0;
    if (Number.isInteger(pid) && pid>0) {
      spawnSync("taskkill",["/PID",String(pid),"/F"],{windowsHide:true,stdio:"ignore"});
    }
  }
}

stopExistingWatcher();

async function hiddenPrompt(label){
  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  if(process.stdin.isTTY) process.stdin.setRawMode(true);
  return await new Promise((resolve)=>{
    let value="";
    const onKey=(str,key)=>{
      if(key?.ctrl&&key.name==="c"){process.exit(130);}
      if(key?.name==="return"){
        if(process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.off("keypress",onKey);
        process.stdout.write("\n");
        resolve(value);
      } else if(key?.name==="backspace"){
        if(value.length){value=value.slice(0,-1);process.stdout.write("\b \b");}
      } else if(str && !key?.ctrl && !key?.meta){
        value+=str;process.stdout.write("*");
      }
    };
    process.stdin.on("keypress",onKey);
  });
}

let existingProtected = "";
const existingConfigPath = path.join(target,"config.json");
if (fs.existsSync(existingConfigPath)) {
  try {
    const current = JSON.parse(fs.readFileSync(existingConfigPath,"utf8"));
    existingProtected = String(current.sharedSecretProtected || "").trim();
  } catch {}
}

let secret = "";
let protectedSecret = existingProtected;
if (!protectedSecret) {
  secret=await hiddenPrompt("Masukkan GOJEK_CONNECTOR_SHARED_SECRET dari Hostinger: ");
  if(!secret.trim()) throw new Error("Shared secret wajib diisi.");
}

const ps=[
  "$ErrorActionPreference='Stop'",
  "$plain=[Console]::In.ReadToEnd()",
  "$sec=ConvertTo-SecureString $plain -AsPlainText -Force",
  "[Console]::Out.Write((ConvertFrom-SecureString $sec))"
].join(";");
if (!protectedSecret) {
  const enc=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",ps],{
    input:secret,encoding:"utf8",windowsHide:true
  });
  if(enc.status!==0) throw new Error("Gagal mengenkripsi secret dengan Windows DPAPI.");
  protectedSecret=String(enc.stdout||"").trim();
}

fs.copyFileSync(path.join(here,"watcher.mjs"),path.join(target,"watcher.mjs"));
fs.writeFileSync(path.join(target,"config.json"),JSON.stringify({
  fleetBaseUrl:"https://fleet.cstlogistic.co.id",
  portalUrl:"https://fleetpartner.gojek.com",
  controlPort:17891,
  sharedSecretProtected:protectedSecret
},null,2),"utf8");

const vbs='Set sh = CreateObject("WScript.Shell")\r\nsh.Run """node"" """ & CreateObject("Scripting.FileSystemObject").BuildPath(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%LOCALAPPDATA%"), "CSTFleetWatcher\\watcher.mjs") & """", 0, False\r\n';
fs.writeFileSync(path.join(target,"start-hidden.vbs"),vbs,"utf8");

const startup=path.join(process.env.APPDATA,"Microsoft","Windows","Start Menu","Programs","Startup","CST Fleet Watcher.vbs");
fs.copyFileSync(path.join(target,"start-hidden.vbs"),startup);

spawn("wscript.exe",[path.join(target,"start-hidden.vbs")],{detached:true,windowsHide:true,stdio:"ignore"}).unref();

console.log("");
console.log("CST Fleet Watcher v3 berhasil dipasang.");
console.log("Watcher akan otomatis hidup setiap Windows login.");
console.log("Sekarang buka CST Fleet > Gojek Connector > Refresh.");
console.log("Status lokal harus menjadi Terhubung.");
