import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(), constructed: vi.fn() }));
vi.mock("pg", () => ({ default: { Pool: class {
  constructor(options: unknown) { fake.constructed(options); }
  query = fake.query;
  connect = fake.connect;
  end = fake.end;
} } }));
vi.mock("../lib/db", () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
import { pool as inventoryPool } from "../lib/db";
import { fleetCashPoolOptions, fleetCashPool, getFleetCashDatabaseStatus } from "../lib/fleet-cash-db";

const original = { ...process.env };
const direct = "postgresql://fleet_cash_source_login_dev:synthetic@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/not-mounted/public-ca.crt";
const identity = { role: "fleet_cash_source_login_dev", login_role: "fleet_cash_source_login_dev", rolsuper: false, rolbypassrls: false, cash_rls: true, outstanding_rls: true, receipt_rls: true };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, { APP_ENV: "development", FLEET_CASH_DATABASE_ENABLED_DEV: "true", FLEET_CASH_DATABASE_URL_DEV: direct, CENTRAL_FINANCE_WRITE_ENABLED: "true" });
});
afterEach(async () => { await fleetCashPool.end(); process.env = { ...original }; });

describe("Dedicated Fleet cash source connection", () => {
  it("pins direct TLS trust and role while ignoring inaccessible DSN file paths", () => {
    const options = fleetCashPoolOptions(direct);
    expect(options).toMatchObject({ host: "db.xssrfshdrtdfupgqwfdw.supabase.co", user: "fleet_cash_source_login_dev", database: "postgres", max: 2, ssl: { rejectUnauthorized: true, servername: "db.xssrfshdrtdfupgqwfdw.supabase.co" } });
    expect((options.ssl as { ca: string }).ca).toContain("BEGIN CERTIFICATE");
    expect(options).not.toHaveProperty("connectionString");
  });
  it("uses system-trusted TLS for the exact project-qualified pooler identity", () => {
    const options = fleetCashPoolOptions("postgresql://fleet_cash_source_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require");
    expect(options).toMatchObject({ max: 2, ssl: { rejectUnauthorized: true } });
    expect(options.ssl).not.toHaveProperty("ca");
  });
  it.each([
    direct.replace("fleet_cash_source_login_dev", "postgres"),
    direct.replace("xssrfshdrtdfupgqwfdw", "nzdweipzckfszczzqtuw"),
    direct.replace("verify-full", "disable"),
    direct.replace("db.xssrfshdrtdfupgqwfdw.supabase.co", "attacker.invalid"),
    direct.replace("/postgres?", "/other?"),
    "not-a-dsn",
  ])("rejects wrong database identity/TLS before opening a pool", (url) => {
    expect(() => fleetCashPoolOptions(url)).toThrow();
    expect(fake.constructed).not.toHaveBeenCalled();
  });
  it("refuses DEV credential selection in production", async () => {
    process.env.APP_ENV = "production";
    await expect(fleetCashPool.query("SELECT 1")).rejects.toThrow("FLEET_CASH_DEV_ONLY");
    expect(inventoryPool.query).not.toHaveBeenCalled();
  });
  it("cannot fall back to inventory reader for an enabled DEV writer", async () => {
    delete process.env.FLEET_CASH_DATABASE_ENABLED_DEV;
    await expect(fleetCashPool.query("SELECT 1")).rejects.toThrow("FLEET_CASH_DEV_DATABASE_REQUIRED");
    expect(inventoryPool.query).not.toHaveBeenCalled();
  });
  it.each([
    { ...identity, rolsuper: true },
    { ...identity, rolbypassrls: true },
    { ...identity, login_role: "postgres" },
    { ...identity, receipt_rls: false },
  ])("refuses an elevated, substituted, or unprotected actual identity", async (row) => {
    fake.query.mockResolvedValueOnce({ rows: [row] });
    await expect(fleetCashPool.query("SELECT source_payment")).rejects.toThrow("FLEET_CASH_DEV_ROLE_OR_RLS_INVALID");
    expect(fake.query).toHaveBeenCalledTimes(1);
    expect(inventoryPool.query).not.toHaveBeenCalled();
  });
  it("reports actual permission capability only after identity and RLS pass", async () => {
    fake.query.mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: [{ cash_read: true, outstanding_read: true, cash_insert: true, cash_status_update: true, cash_link_update: true, cash_time_update: true, balance_update: true, outstanding_status_update: true, resolved_update: true, outstanding_time_update: true, sequence_use: true }] });
    await expect(getFleetCashDatabaseStatus()).resolves.toMatchObject({ readReady: true, writeReady: true, sourceCompanyId: 1 });
    expect(inventoryPool.query).not.toHaveBeenCalled();
  });
  it("never calls disabled source readiness ready", async () => {
    process.env.FLEET_CASH_DATABASE_ENABLED_DEV = "false";
    await expect(getFleetCashDatabaseStatus()).resolves.toMatchObject({ enabled: false, readReady: false, writeReady: false });
    expect(fake.query).not.toHaveBeenCalled();
  });
});
