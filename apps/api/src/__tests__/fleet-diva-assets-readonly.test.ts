import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const page = readFileSync(resolve(process.cwd(), "../web/src/pages/vehicles.tsx"), "utf8");
const migration = readFileSync(resolve(process.cwd(), "../../deploy/dev-only/diva-asset-reader-company3-20261118.sql"), "utf8");

describe("Diva-owned Fleet DEV assets stay separate from CST operating records", () => {
  it("uses an authenticated DEV-only Owner/Super Admin read endpoint", () => {
    const route = api.split('router.get("/vehicles/diva-assets"')[1]?.split('router.get("/vehicles"')[0];
    expect(route).toBeTruthy();
    expect(route).toContain('process.env.APP_ENV !== "development"');
    expect(route).toContain('["owner", "super_admin"]');
    expect(route).toContain('tableExists("fleet_units")');
    expect(route).toContain('FROM public.fleet_units');
    expect(route).toContain("WHERE company_id=$1");
    expect(route).toContain('["3"]');
    expect(route).toContain('Cache-Control", "private, no-store"');
    expect(route).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+|FROM\s+)?public\.fleet_/i);
  });

  it("retains the existing company-scoped operations inventory", () => {
    const section = api.split('router.get("/vehicles",')[1]?.split('router.post("/vehicles",')[0];
    expect(section).toContain("const cid = companyId(req)");
    expect(section).toContain("WHERE v.company_id=$1");
    expect(section).not.toContain("fleet_units");
    expect(page).toContain("/api/logistics/fleet/vehicles");
    expect(page).toContain("/api/logistics/fleet/vehicles/diva-assets");
    expect(page).toContain("Aset PT Diva Servis");
    expect(page).toContain("baca-saja");
  });

  it("grants limited columns and RLS SELECT to exactly the existing DEV role", () => {
    expect(migration).toContain("fleet_dev_stage_reader");
    expect(migration).toContain("GRANT SELECT (company_id,plate_number,brand,model,ownership_type,status,unit_number)");
    expect(migration).toContain("AS PERMISSIVE FOR SELECT");
    expect(migration).toContain("AS RESTRICTIVE FOR SELECT");
    expect(migration).toContain("company_id = ''3''");
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)/i);
  });
});
