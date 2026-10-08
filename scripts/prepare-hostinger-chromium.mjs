import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtimeDir = resolve(root, "apps/api/dist/chromium-runtime");

await rm(runtimeDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });

process.env.TMPDIR = runtimeDir;
process.env.TMP = runtimeDir;
process.env.TEMP = runtimeDir;

const { default: chromium } = await import("@sparticuz/chromium");
chromium.setGraphicsMode = false;

const executablePath = await chromium.executablePath();
if (!existsSync(executablePath)) {
  throw new Error(`Chromium build-time extraction failed: ${executablePath}`);
}

await writeFile(
  resolve(runtimeDir, "runtime.json"),
  JSON.stringify({
    executablePath,
    relativeExecutable: executablePath.replace(runtimeDir, "."),
    preparedAt: new Date().toISOString(),
  }) + "\n",
  "utf8",
);

console.log(`Prepared portable Chromium for Hostinger runtime: ${executablePath}`);
