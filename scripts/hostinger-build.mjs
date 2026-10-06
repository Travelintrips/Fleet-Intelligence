import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

function run(command, args, cwd = root) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

await run("npm", ["run", "build:workspace"]);

const webDist = resolve(root, "apps/web/dist");
const apiPublic = resolve(root, "apps/api/dist/public");

await rm(apiPublic, { recursive: true, force: true });
await mkdir(apiPublic, { recursive: true });
await cp(webDist, apiPublic, { recursive: true });

console.log("Prepared Hostinger production bundle: apps/api/dist + embedded web public assets");
