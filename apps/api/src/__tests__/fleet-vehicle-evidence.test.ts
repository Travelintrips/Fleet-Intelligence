import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { assessFleetVehicleEvidence } from "../lib/fleet-vehicle-evidence";

const at = new Date("2026-11-16T07:00:00.000Z"); // 14:00 WIB
const valid = {
  driverStatus: "active",
  snapshotPresent: true,
  transactionCount: 12,
  lastTransactionDate: "2026-11-15",
};

describe("Fleet vehicle reconciliation is read-only evidence, never dispatch approval", () => {
  it("marks four corroborating data conditions without changing master status", () => {
    expect(assessFleetVehicleEvidence(valid, at)).toEqual({
      evidence_status: "corroborated", evidence_reason: null,
    });
  });

  it("fails closed for inactive and suspended drivers, regardless of historical transactions", () => {
    for (const status of ["inactive", "suspended", "fired", null]) {
      expect(assessFleetVehicleEvidence({ ...valid, driverStatus: status }, at))
        .toEqual({ evidence_status: "review", evidence_reason: "driver_not_active" });
    }
  });

  it("requires exact true for the latest Gojek snapshot", () => {
    for (const state of [false, null, undefined, "true"]) {
      expect(assessFleetVehicleEvidence({ ...valid, snapshotPresent: state }, at))
        .toEqual({ evidence_status: "review", evidence_reason: "snapshot_missing" });
    }
  });

  it("treats zero transactions differently from missing transaction data", () => {
    expect(assessFleetVehicleEvidence({ ...valid, transactionCount: 0 }, at))
      .toEqual({ evidence_status: "review", evidence_reason: "no_transactions" });
    expect(assessFleetVehicleEvidence({ ...valid, transactionCount: null }, at))
      .toEqual({ evidence_status: "unknown", evidence_reason: "transactions_unavailable" });
    expect(assessFleetVehicleEvidence({ ...valid, transactionCount: -2 }, at).evidence_status)
      .toBe("unknown");
  });

  it("enforces 30 days in Jakarta time, rejects future and invalid dates", () => {
    expect(assessFleetVehicleEvidence({ ...valid, lastTransactionDate: "2026-10-17" }, at).evidence_status)
      .toBe("corroborated");
    expect(assessFleetVehicleEvidence({ ...valid, lastTransactionDate: "2026-10-16" }, at))
      .toEqual({ evidence_status: "review", evidence_reason: "stale_transaction" });
    for (const invalid of ["2026-11-17", "2026-99-99", null, "not-a-date"]) {
      expect(assessFleetVehicleEvidence({ ...valid, lastTransactionDate: invalid }, at).evidence_status)
        .toBe("unknown");
    }
  });

  it("reproduces 44 complete / 8 review for a synthetic fixture only", () => {
    const sample = [
      ...Array.from({ length: 44 }, () => valid),
      ...Array.from({ length: 4 }, () => ({ ...valid, driverStatus: "inactive" })),
      ...Array.from({ length: 2 }, () => ({ ...valid, transactionCount: 0 })),
      { ...valid, snapshotPresent: false },
      { ...valid, lastTransactionDate: "2026-10-13" },
    ];
    const statuses = sample.map((x) => assessFleetVehicleEvidence(x, at).evidence_status);
    expect(statuses.filter((x) => x === "corroborated")).toHaveLength(44);
    expect(statuses.filter((x) => x === "review")).toHaveLength(8);
  });

  it("keeps the authenticated company-scoped existing GET route and no mutation in preview", () => {
    const api = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
    const section = api.split('router.get("/vehicles"')[1]?.split('router.post("/vehicles"')[0];
    expect(section).toBeDefined();
    expect(api).toContain("authenticateAdmin");
    expect(section).toContain("const cid = companyId(req)");
    expect(section).toContain("WHERE v.company_id=$1");
    expect(section).toContain("WHERE company_id=$1");
    expect(section).toContain("tableExists(\"fleet_transactions\")");
    expect(section).toContain("assessFleetVehicleEvidence");
    expect(section).toContain('Cache-Control", "private, no-store');
    expect(section).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\s+(?:INTO\s+|FROM\s+)?public\.fleet_/i);
  });

  it("keeps inventory and evidence statuses separate in the Fleet page", () => {
    const page = readFileSync(resolve(process.cwd(), "../web/src/pages/vehicles.tsx"), "utf8");
    expect(page).toContain('label: "Aktif (Master)"');
    expect(page).toContain('label: "Bukti 4 Kriteria"');
    expect(page).toContain("Bukti data diperiksa terpisah");
    expect(page).toContain("Status Driver");
    expect(page).toContain("Transaksi Terakhir");
  });
});
