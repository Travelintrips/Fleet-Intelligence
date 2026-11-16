import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const api = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const migration = readFileSync(resolve(process.cwd(), "../../deploy/dev-only/004_fleet_cst_transaction_reader_columns.sql"), "utf8");
const route = api.split('router.get("/transactions"')[1]?.split('router.get("/drivers"')[0];

describe("DEV Transactions reader is SELECT-only and company-scoped", () => {
  it("uses an explicit payload projection rather than SELECT *", () => {
    expect(route).toBeDefined();
    expect(route).not.toContain("SELECT *\n         FROM public.fleet_transactions");
    expect(route).toContain(
      "SELECT id,transaction_date,driver_name,vehicle_plate,service_type,",
    );
    for (const sensitive of ["raw_data", "driver_phone", "gopay_reference_id", "created_at"]) {
      expect(route?.split("FROM public.fleet_transactions")[0]).not.toContain(sensitive);
    }
    expect(route).toContain("WHERE company_id=$1");
    expect(route).toContain("d.status='active'");
    expect(route).toContain("COALESCE(d.source_present_in_latest_snapshot,true)=true");
    expect(route).toContain("excludedByEligibility");
    expect(route).toContain("rental_fee_signed_net");
  });

  it("adds no write privilege or table-wide financial SELECT and preserves CST RLS", () => {
    expect(migration).toContain("CST-DEV ONLY");
    expect(migration).toContain("fleet_dev_cst_transaction_select");
    expect(migration).toContain("qual LIKE '%company_id = 1%'");
    expect(migration).toContain("GRANT SELECT (");
    expect(migration).toContain("ON TABLE public.fleet_transactions TO fleet_dev_cst_inventory_reader");
    expect(migration).toContain("GRANT SELECT (vehicle_plate)");
    expect(migration).toContain("GRANT SELECT (company_id)");
    expect(migration).toContain("USING (company_id = 1)");
    expect(migration).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)\b/i);
    expect(migration).not.toContain("GRANT SELECT ON TABLE");
    expect(migration).not.toContain("GRANT SELECT *");
  });
});
