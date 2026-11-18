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
    expect(route).toContain("WHERE u.company_id=$1");
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
  it("keeps DEV staging proxy exact GET-only for Diva asset reads", () => {
    const conf = readFileSync(resolve(process.cwd(), "../../deploy/dev-only/nginx-staging-readonly.conf"), "utf8");
    const section = conf.split("location = /api/logistics/fleet/vehicles/diva-assets {")[1]?.split("location = /api/logistics/fleet/transactions {")[0];
    expect(section).toBeDefined();
    expect(section).toContain("limit_except GET { deny all;");
    expect(section).toContain("proxy_pass http://fleet-api:8080");
    expect(section).toContain("proxy_set_header Cookie $http_cookie");
    expect(conf).toContain("location / { return 404; }");
  });
  it("adds read-only annual tax expiry and renewal evidence without document secrets", () => {
    const route = api.split('router.get("/vehicles/diva-assets"')[1]?.split('router.get("/vehicles"')[0];
    expect(route).toContain("LEFT JOIN LATERAL");
    expect(route).toContain("FROM public.fleet_documents d");
    expect(route).toContain("d.company_id=u.company_id");
    expect(route).toContain("d.fleet_unit_id=u.id");
    expect(route).toContain("d.doc_type='annual_vehicle_tax'");
    expect(route).toContain("tax.expired_date::text AS tax_due_date");
    expect(route).not.toContain("file_url");
    expect(page).toContain("Pajak tahunan habis");
    expect(page).toContain("Menunggu bukti pajak baru");
    expect(page).toContain("Belum diperpanjang");
    const taxSql = readFileSync(resolve(process.cwd(), "../../deploy/dev-only/diva-annual-tax-readonly-20261118.sql"), "utf8");
    expect(taxSql).toContain("GRANT SELECT (id) ON public.fleet_units");
    expect(taxSql).toContain("GRANT SELECT (company_id,fleet_unit_id,doc_type,issued_date,expired_date,status,reminder_days)");
    expect(taxSql).toContain("AS PERMISSIVE FOR SELECT");
    expect(taxSql).toContain("AS RESTRICTIVE FOR SELECT");
    expect(taxSql).not.toMatch(/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)/i);
  });
});
