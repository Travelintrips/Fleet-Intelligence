import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(),
  "../../deploy/dev-only/002_fleet_plate_uniqueness_guard.sql"), "utf8");

describe("Fleet DEV canonical source duplicate-plate guard", () => {
  it("fails closed outside the prepared CST-DEV database", () => {
    expect(source).toContain("xssrfshdrtdfupgqwfdw");
    expect(source).toContain("to_regrole('fleet_dev_cst_inventory_reader')");
    expect(source).toContain("CST_DEV_FLEET_READER_ROLE_REQUIRED");
    expect(source).toContain("CST_DEV_FLEET_MUST_BE_EMPTY_BEFORE_UNIQUE_GUARD");
    expect(source).toContain("EXISTS (SELECT 1 FROM public.fleet_vehicles)");
  });
  it("uniquely indexes normalized physical plates per company", () => {
    expect(source).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(source).toContain("fleet_vehicles_company_platekey_uniq_dev_20261116");
    expect(source).toContain("ON public.fleet_vehicles");
    expect(source).toContain("company_id,");
    expect(source).toContain("upper(regexp_replace(coalesce(plate,''),'[^[:alnum:]]','','g'))");
    expect(source).toContain("WHERE NULLIF(btrim(plate),'') IS NOT NULL");
  });
  it("does not change Fleet tables, RLS, scheduler or application code", () => {
    expect(source).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(source).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(source).not.toMatch(/\bGRANT\s+/i);
    expect(source).not.toMatch(/\bUPDATE\s+public\./i);
    expect(source).not.toMatch(/\bINSERT\s+INTO\s+public\./i);
    expect(source).not.toMatch(/\bDELETE\s+FROM\s+public\./i);
  });
});
