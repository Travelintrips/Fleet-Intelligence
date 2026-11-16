import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const roleSql = readFileSync(
  resolve(process.cwd(), "../../deploy/dev-only/001_fleet_cst_inventory_reader_nologin.sql"),
  "utf8",
);
const scheduler = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");

describe("CST-DEV inventory evidence reader role, NOLOGIN fail-closed", () => {
  it("must never be installed by automatic PROD migrations", () => {
    expect(roleSql).toContain("CST-DEV ONLY");
    expect(roleSql).toContain("xssrfshdrtdfupgqwfdw");
    expect(roleSql).toContain("CONNECTION LIMIT 0");
    expect(roleSql).toContain("NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
    expect(roleSql).toContain("default_transaction_read_only = on");
    expect(roleSql).not.toMatch(/\b(?:ALTER\s+ROLE|CREATE\s+ROLE)\s+postgres\b/i);
    const declaration = roleSql.split("CREATE ROLE fleet_dev_cst_inventory_reader")[1]?.split(";")[0];
    expect(declaration).toBeTruthy();
    expect(declaration).toContain("NOLOGIN");
    expect(declaration).not.toMatch(/(?:^|\s)LOGIN(?:\s|$)/);
    expect(roleSql).not.toMatch(/ALTER\s+ROLE\s+fleet_dev_cst_inventory_reader\s+(?:WITH\s+)?LOGIN\b/i);
  });

  it("grants read-only access on Fleet tables, not writes or unrelated data", () => {
    expect(roleSql).toContain("GRANT SELECT ON public.fleet_vehicles");
    expect(roleSql).toContain("GRANT SELECT (id, company_id, full_name, driver_external_id");
    expect(roleSql).toContain("GRANT SELECT (company_id, vehicle_plate, transaction_date)");
    expect(roleSql).not.toMatch(/\bGRANT\s+(?:ALL|INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i);
    expect(roleSql).not.toContain("GRANT SELECT ON ALL TABLES");
    expect(roleSql).not.toContain("fleet_dev_cst_inventory_reader TO postgres");
  });

  it("restricts customer tenant to exact CST id in every RLS policy", () => {
    expect(roleSql).toContain("USING (company_id = 1)");
    expect(roleSql).toContain("USING (company_id = '1')");
    expect(roleSql).toContain("USING (id = 1 AND code = 'CST' AND is_active IS TRUE)");
    const policies=(roleSql.match(/CREATE POLICY /g)??[]).length;
    expect(policies).toBe(4);
    expect(roleSql).not.toMatch(/\bWITH\s+CHECK\b/i);
  });

  it("preserves scheduler disabled in the Fleet DEV entrypoint", () => {
    expect(scheduler).toContain('isDevelopmentEnvironment() && process.env.DISABLE_BACKGROUND_SCHEDULERS === "true"');
  });
});
