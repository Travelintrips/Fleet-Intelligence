import { describe, it, expect } from "vitest";
import { fleetVehicleReadSql } from "../lib/fleet-vehicle-read-model";

describe("Fleet Vehicles evidence read model", () => {
  it("isolates source, driver and transaction rows to the signed company", () => {
    const q = fleetVehicleReadSql(true);
    expect(q).toContain("WHERE v.company_id=$1");
    expect(q).toContain("WHERE t.company_id=$1");
    expect(q).toContain("activity.company_id=v.company_id");
    expect(q).toContain("d.company_id=v.company_id::text");
    expect(q).toContain("LIMIT $2");
    expect(q).toContain("MAX(t.transaction_date) AS last_transaction_date");
    expect(q).toContain("COUNT(*)::int AS tx_count");
    expect(q).toContain("AS driver_status");
    expect(q).not.toMatch(/INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+public\./i);
  });
  it("does not break company-scoped inventory GET if transaction table is absent", () => {
    const q = fleetVehicleReadSql(false);
    expect(q).toContain("WHERE v.company_id=$1");
    expect(q).toContain("0::int AS tx_count");
    expect(q).toContain("NULL::date AS last_transaction_date");
    expect(q).not.toContain("FROM public.fleet_transactions");
  });
  it("does not mistake transaction count for driver trips or login", () => {
    const q = fleetVehicleReadSql(true);
    expect(q).not.toContain("SUM(t.trip_count)");
    expect(q).not.toContain("last_login_at");
  });
});
