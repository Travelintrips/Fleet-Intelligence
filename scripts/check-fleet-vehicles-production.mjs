import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Read-only post-deployment assertion. No session, cookie, or privileged API key. */
export function vehicleBundleHasEvidence(bundle) {
  return [
    "Bukti Data",
    "Transaksi Terakhir",
    "Perlu Review",
    "Status Kendaraan",
    "Driver Aktif",
    "bukan izin dispatch",
  ].every((label) => typeof bundle === "string" && bundle.includes(label));
}

export function extractFleetMainAsset(html) {
  if (typeof html !== "string") return null;
  return html.match(/\bsrc=["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["']/)?.[1] ?? null;
}

export function extractFleetVehicleAsset(mainJs) {
  if (typeof mainJs !== "string") return null;
  const matched = mainJs.match(/\b(vehicles-[A-Za-z0-9_-]+\.js)\b/);
  return matched ? "/assets/" + matched[1] : null;
}

async function fetchText(origin, path, expectedStatus) {
  const res = await fetch(origin + path, {
    method: "GET",
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(16000),
    headers: { "accept": "text/html,application/javascript,application/json" },
  });
  if (res.status !== expectedStatus) {
    throw new Error(`Unexpected ${path} HTTP ${res.status}, expected ${expectedStatus}`);
  }
  if (expectedStatus !== 200) return "";
  return res.text();
}

async function main() {
  const origin = (process.env.BASE_URL || "https://fleet.cstlogistic.co.id").replace(/\/$/, "");
  const target = new URL(origin);
  if (target.origin !== "https://fleet.cstlogistic.co.id" || target.pathname !== "/") {
    throw new Error("Refuse to check a non-production Fleet domain");
  }
  const expected = process.env.EXPECTED_SHA || "";
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error("Exact expected deploy SHA required");
  const version = JSON.parse(await fetchText(origin, "/deploy-version.json", 200));
  if (version.commit !== expected || version.service !== "fleet-intelligence") {
    throw new Error("Fleet PROD deployed code does not match the guarded commit");
  }
  const html = await fetchText(origin, "/logistics/fleet-intelligence/vehicles", 200);
  const mainAsset = extractFleetMainAsset(html);
  if (!mainAsset) throw new Error("Fleet PROD SPA missing main asset");
  const js = await fetchText(origin, mainAsset, 200);
  const vehiclesAsset = extractFleetVehicleAsset(js);
  if (!vehiclesAsset) throw new Error("Fleet PROD SPA does not reference vehicles module");
  const vehicleJs = await fetchText(origin, vehiclesAsset, 200);
  if (!vehicleBundleHasEvidence(vehicleJs)) {
    throw new Error("Fleet PROD Vehicles UI is missing issue #101 evidence labels");
  }
  await fetchText(origin, "/healthz", 200);
  await fetchText(origin, "/api/readyz", 200);
  await fetchText(origin, "/api/logistics/fleet/vehicles", 401);
  console.log("Fleet PROD Vehicles Issue #101 release gate PASS: exact SHA, evidence UI, health/ready and anonymous denial.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Fleet PROD Vehicles issue #101 release gate FAILED: " +
      (err instanceof Error ? err.message : "unknown error"));
    process.exitCode = 1;
  });
}
