import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const webDist = resolve(root, "apps/web/dist");
const apiPublic = resolve(root, "apps/api/dist/public");

await rm(apiPublic, { recursive: true, force: true });
await mkdir(apiPublic, { recursive: true });
await cp(webDist, apiPublic, { recursive: true });

let commit = String(process.env.HOSTINGER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "").trim();
if (!commit) {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    commit = "unknown";
  }
}

await writeFile(
  resolve(apiPublic, "deploy-version.json"),
  JSON.stringify({
    service: "fleet-intelligence",
    commit,
    builtAt: new Date().toISOString(),
  }) + "\n",
  "utf8",
);

console.log(`Prepared Hostinger production bundle for commit ${commit}`);
