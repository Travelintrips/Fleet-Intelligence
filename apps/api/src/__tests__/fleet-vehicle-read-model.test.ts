import { describe, it, expect } from "vitest";
import { fleetVehicleReadSql, withFleetVehicleEvidence } from "../lib/fleet-vehicle-read-model";

const TODAY = new Date("2026-11-17T12:00:00.000Z");
const BASE = {
  status: "active",
  driver_id: 1,
  driver_status: "active",
  driver_in_latest_snapshot: true,
  tx_count: 4,
  last_transaction_date: "2026-11-16",
};

function reasons(overrides: Record<string, unknown> = {}): string[] {
  return withFleetVehicleEvidence({ ...BASE, ...overrides }, TODAY).review_reasons;
}

describe("Fleet Vehicles isolated, read-only SQL model — Issue #101", () => {
  it("isolates vehicles, drivers and transactions to the signed company", () => {
    const query = fleetVehicleReadSql(true);
    expect(query).toContain("WHERE v.company_id=$1");
    expect(query).toContain("WHERE t.company_id=$1");
    expect(query).toContain("activity.company_id=v.company_id");
    expect(query).toContain("d.company_id=v.company_id::text");
    expect(query).toContain("LIMIT $2");
    expect(query).toContain("MAX(t.transaction_date) AS last_transaction_date");
    expect(query).toContain("COUNT(*)::int AS tx_count");
    expect(query).toContain("d.status AS driver_status");
    expect(query).toContain("d.source_present_in_latest_snapshot AS driver_in_latest_snapshot");
    expect(query).not.toMatch(/INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+public\./i);
  });

  it("normalizes plates consistently and never matches empty normalized plates", () => {
    const query = fleetVehicleReadSql(true);
    expect(query).toContain("regexp_replace(coalesce(t.vehicle_plate");
    expect(query).toContain("regexp_replace(coalesce(v.plate");
    expect(query).toContain("NULLIF(upper(regexp_replace(coalesce(t.vehicle_plate");
  });

  it("preserves SELECT inventory and fails closed when transaction table is absent", () => {
    const query = fleetVehicleReadSql(false);
    expect(query).toContain("WHERE v.company_id=$1");
    expect(query).toContain("0::int AS tx_count");
    expect(query).toContain("NULL::date AS last_transaction_date");
    expect(query).toContain("driver_in_latest_snapshot");
    expect(query).not.toContain("FROM public.fleet_transactions");
    expect(reasons({tx_count:0,last_transaction_date:null})).toContain(
      "Belum ada transaksi kendaraan yang terverifikasi",
    );
  });

  it("counts transaction rows, never trip_count or driver logins", () => {
    const query = fleetVehicleReadSql(true);
    expect(query).not.toContain("SUM(t.trip_count)");
    expect(query).not.toContain("last_login_at");
  });
});

describe("Fleet vehicle four-criteria evidence — review only, no dispatch", () => {
  it("keeps valid active vehicle, active driver, current snapshot and recent transactions clear of review", () => {
    const result = withFleetVehicleEvidence(BASE, TODAY);
    expect(result.needs_review).toBe(false);
    expect(result.review_reasons).toEqual([]);
    expect(result.status).toBe("active");
    expect(result.tx_count).toBe(4);
    expect(BASE).not.toHaveProperty("needs_review");
  });

  it("does not treat vehicle active status as a guarantee about driver status", () => {
    expect(reasons({driver_status:"inactive"})).toContain("Status driver tidak aktif atau belum terverifikasi");
    expect(reasons({driver_status:"suspended"})).toContain("Driver ditangguhkan");
    expect(reasons({driver_status:null})).toContain("Status driver tidak aktif atau belum terverifikasi");
  });

  it("requires a linked same-company driver for its evidence", () => {
    expect(reasons({driver_id:null,driver_status:null})).toContain("Driver belum ditetapkan");
  });

  it("requires an explicitly current Gojek snapshot, not null or missing", () => {
    expect(reasons({driver_in_latest_snapshot:false})).toContain("Driver tidak ada pada snapshot Gojek terbaru");
    expect(reasons({driver_in_latest_snapshot:null})).toContain("Driver tidak ada pada snapshot Gojek terbaru");
  });

  it("flags inactive vehicle even with active driver and current transactions", () => {
    expect(reasons({status:"inactive"})).toContain("Status kendaraan tidak aktif");
  });

  it("flags missing transaction counts and last transaction date", () => {
    expect(reasons({tx_count:0,last_transaction_date:null})).toContain("Belum ada transaksi kendaraan yang terverifikasi");
    expect(reasons({tx_count:undefined,last_transaction_date:undefined})).toContain("Belum ada transaksi kendaraan yang terverifikasi");
  });

  it("flags stale and future transaction dates, including invalid date strings", () => {
    for (const date of ["2026-10-17", "2026-11-18", "2026-13-15"]) {
      expect(reasons({last_transaction_date:date})).toContain("Tidak ada transaksi dalam 30 hari terakhir");
    }
  });

  it("includes the 30-day boundary and accepts PostgreSQL Date objects", () => {
    expect(reasons({last_transaction_date:"2026-10-18"})).toEqual([]);
    expect(reasons({last_transaction_date:new Date("2026-11-16T00:00:00.000Z")})).toEqual([]);
  });

  it("returns multiple accurate reasons while preserving the original record", () => {
    const input = {
      ...BASE, status:"inactive", driver_status:"suspended",
      driver_in_latest_snapshot:false,tx_count:0,last_transaction_date:null,
    };
    const result = withFleetVehicleEvidence(input, TODAY);
    expect(result.needs_review).toBe(true);
    expect(result.review_reasons.length).toBe(4);
    expect(result.driver_status).toBe("suspended");
    expect(input).not.toHaveProperty("review_reasons");
  });
});
