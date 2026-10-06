import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const webDist = resolve(root, "apps/web/dist");
const apiPublic = resolve(root, "apps/api/dist/public");

await rm(apiPublic, { recursive: true, force: true });
await mkdir(apiPublic, { recursive: true });
await cp(webDist, apiPublic, { recursive: true });

console.log("Prepared Hostinger production bundle: apps/api/dist + embedded web public assets");
