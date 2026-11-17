import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { fleetVehicleEvidenceView } from "./fleet-vehicle-evidence";

const ui = readFileSync(resolve(process.cwd(), "src/pages/vehicles.tsx"), "utf8");
describe("Fleet Vehicles UI evidence labeling", () => {
  it("uses the projection rather than non-existing legacy activity fields", () => {
    expect(ui).toContain("fmtDate(v.last_transaction_date)");
    expect(ui).toContain("v.tx_count");
    expect(ui).toContain("Transaksi Terakhir");
    expect(ui).not.toContain("v.last_seen_date");
  });
  it("separates inventory and driver statuses and shows review reasons", () => {
    expect(ui).toContain("Status Kendaraan");
    expect(ui).toContain("Aktif Kendaraan");
    expect(ui).toContain("Driver Aktif");
    expect(ui).toContain("Perlu Review");
    expect(ui).toContain("v.driver_status");
    expect(ui).toContain("fleetVehicleEvidenceView(v)");
    expect(ui).toContain('evidence.reasons.join(" · ")');
    expect(ui).toContain("bukan izin dispatch");
  });
  it("preserves read errors rather than showing false empty inventory", () => {
    expect(ui).toContain("if (!res.ok) throw new Error");
    expect(ui).toContain("isError");
    expect(ui).toContain("tidak menyimpulkan armada kosong");
  });
});
describe("Legacy or incomplete Vehicles API evidence is never auto-approved", () => {
  it("marks old API without evidence fields as unverified", () => {
    expect(fleetVehicleEvidenceView({status:"active",tx_count:4})).toEqual({
      label:"Belum diverifikasi",
      tone:"unknown",
      reasons:["API belum menyediakan bukti data lengkap"],
    });
  });
  it("shows accurate review reasons for failing the four criteria", () => {
    expect(fleetVehicleEvidenceView({
      needs_review:true,review_reasons:["Driver ditangguhkan","Tidak ada transaksi dalam 30 hari terakhir"],
    })).toMatchObject({label:"Perlu Review",tone:"warning"});
  });
  it("only presents a green evidence label for fully consistent server evidence", () => {
    expect(fleetVehicleEvidenceView({needs_review:false,review_reasons:[]})).toMatchObject({
      label:"Bukti data cocok",tone:"ok",
    });
    expect(fleetVehicleEvidenceView({needs_review:false,review_reasons:["Driver ditangguhkan"]}).tone).toBe("unknown");
    expect(fleetVehicleEvidenceView({needs_review:true,review_reasons:[]}).tone).toBe("unknown");
  });
});
