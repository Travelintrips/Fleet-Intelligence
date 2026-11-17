import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractFleetMainAsset, extractFleetVehicleAsset, vehicleBundleHasEvidence,
} from "./check-fleet-vehicles-production.mjs";

test("Fleet release guard sees the actual built Hostinger vehicles evidence asset", () => {
  const root = resolve("apps/api/dist/public");
  const html = readFileSync(resolve(root,"index.html"),"utf8");
  const main = extractFleetMainAsset(html);
  assert.match(main, /^\/assets\/index-[A-Za-z0-9_-]+\.js$/);
  const indexJS = readFileSync(resolve(root,main.slice(1)),"utf8");
  const vehicles = extractFleetVehicleAsset(indexJS);
  assert.match(vehicles, /^\/assets\/vehicles-[A-Za-z0-9_-]+\.js$/);
  const vehicleJS = readFileSync(resolve(root,vehicles.slice(1)),"utf8");
  assert.equal(vehicleBundleHasEvidence(vehicleJS),true);
});
test("Fleet release guard rejects legacy/missing assets", () => {
  assert.equal(vehicleBundleHasEvidence("Transaksi Terakhir Status Kendaraan"),false);
  assert.equal(vehicleBundleHasEvidence(""),false);
  assert.equal(extractFleetVehicleAsset("missing vehicle chunk"),null);
  assert.equal(extractFleetMainAsset("missing index module"),null);
  assert.equal(extractFleetMainAsset('<script src="/assets/index-1.js"></script>'),"/assets/index-1.js");
});
