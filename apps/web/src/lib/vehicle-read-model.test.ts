import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ui = readFileSync(resolve(process.cwd(), "src/pages/vehicles.tsx"), "utf8");
describe("Fleet Vehicles UI evidence labeling", () => {
  it("uses the API transaction projection rather than unpopulated legacy fields", () => {
    expect(ui).toContain("fmtDate(v.last_transaction_date)");
    expect(ui).toContain("v.tx_count");
    expect(ui).toContain("Transaksi Terakhir");
    expect(ui).not.toContain("v.last_seen_date");
  });
  it("keeps inventory status and assigned-driver status distinct", () => {
    expect(ui).toContain("Status Kendaraan");
    expect(ui).toContain("v.driver_status");
    expect(ui).toContain("bukan izin dispatch");
  });
});
