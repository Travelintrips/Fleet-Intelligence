import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import pinoHttp from "pino-http";
import type { Server } from "node:http";

// End-to-end HTTP routing test with entirely SYNTHETIC Google identity and
// a mocked database. It must never access real Google accounts or live DB.
vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async () => { throw new Error("Unconfigured test SQL"); }),
    connect: vi.fn(() => { throw new Error("DEV read-only API must never open a writer"); }),
  },
}));

const ORIGIN = "https://dev-fleet.cstlogistic.co.id";
const AUTH_ID = "2d504b60-9172-4a2d-910b-2d80d9214156";
const CANON = "42";
const originalFetch = globalThis.fetch;
const envKeys = [
  "APP_ENV", "NODE_ENV", "APP_BASE_URL", "SESSION_SECRET",
  "FLEET_DEV_GOOGLE_AUTH_ENABLED", "FLEET_DEV_SUPABASE_PUBLISHABLE_KEY",
  "FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID", "FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID",
  "SUPABASE_DATABASE_URL_DEV",
] as const;
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

const jwt = () => "eyJhbGciOiJIUzI1NiJ9." +
  Buffer.from(JSON.stringify({
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 900,
    amr: [{ method: "oauth" }],
  })).toString("base64url") + ".only_for_mocked_gotrue_tests";

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Fleet DEV Google Super Admin to Transactions HTTP integration (MOCKED only)", () => {
  it("blocks anonymous requests and authorizes scoped read-only Fleet records using synthetic Google SSO", async () => {
    Object.assign(process.env, {
      APP_ENV: "development",
      NODE_ENV: "production",
      APP_BASE_URL: ORIGIN,
      SESSION_SECRET: "synthetic_session_key_for_mocked_integration_only_2026",
      FLEET_DEV_GOOGLE_AUTH_ENABLED: "true",
      FLEET_DEV_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_not_real",
      FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID: AUTH_ID,
      FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID: CANON,
      SUPABASE_DATABASE_URL_DEV: "postgresql://synthetic.xssrfshdrtdfupgqwfdw:fake@127.0.0.1:65432/synthetic",
    });

    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const uri = String(url);
      if (!uri.startsWith("https://xssrfshdrtdfupgqwfdw.supabase.co/auth/v1/user"))
        throw new Error("Mocked auth test cannot contact other external endpoints");
      return new Response(JSON.stringify({
        id: AUTH_ID,
        email: "synthetic.dev@example.invalid",
        email_confirmed_at: "2026-11-16T01:00:00Z",
        app_metadata: {
          provider: "google", providers: ["google"],
          ai_task_user_id: CANON, ai_task_role: "super_admin",
          ai_task_company_id: "@NULL@",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const { pool } = await import("../lib/db");
    const query = vi.mocked(pool.query);
    query.mockImplementation(async (sqlInput: unknown, paramsInput?: unknown) => {
      const sql = String(sqlInput);
      const params = (Array.isArray(paramsInput) ? paramsInput : []) as unknown[];
      if (sql.includes("to_regclass($1) IS NOT NULL AS exists"))
        return { rows: [{ exists: true }] } as never;
      expect(params[0]).toBe(1); // No company 2 read even in mocked test
      if (sql.includes("SELECT v.*, d.full_name AS driver_name")) {
        return { rows: Array.from({ length: 44 }, (_, idx) => ({
          id: idx + 1, company_id: 1, plate: "SYNTH" + idx,
          driver_name: "FICTITIOUS_DRIVER",
          driver_status: "active", snapshot_present: true,
          tx_count: idx < 40 ? 2 : 0,
          last_transaction_date: "2026-11-04",
        })) } as never;
      }
      if (sql.includes("SELECT id,transaction_date,driver_name,vehicle_plate,service_type,")) {
        return { rows: params[1] === "2026-11-05" ? [] : Array.from({ length: 5 }, (_, idx) => ({
          id: idx + 1, company_id: 1, transaction_date: "2026-11-04",
          driver_name: "FICTITIOUS_DRIVER", vehicle_plate: "SYNTH" + idx,
          service_type: null, trip_count: 0, amount: 1000,
          transaction_type: "Rental fee due",
          gross_revenue: 1000, net_revenue: 1000,
        })) } as never;
      }
      if (sql.includes("AS rental_fee_rows")) return { rows: [{
        total: params[1] === "2026-11-05" ? 0 : 413,
        total_trips: 0, total_net: "409667.0000",
        total_gross: "4560000.0000", rental_fee_rows: params[1] === "2026-11-05" ? 0 : 413,
        rental_fee_signed_net: "409667.0000",
        rental_fee_due_total: "4560000.0000",
        rental_fee_deduction_total: "-4150333.0000",
      }] } as never;
      if (sql.includes("public.gojek_raw_transactions") && sql.includes("COUNT(*)"))
        return { rows: [{ count: 425 }] } as never;
      if (sql.includes("MIN(transaction_date)::text AS first_available_date"))
        return { rows: [{
          total_rows: 425, first_available_date: "2026-11-01",
          last_available_date: "2026-11-04",
        }] } as never;
      if (sql.includes("SELECT COUNT(*)::int AS total") && sql.includes("public.fleet_transactions"))
        return { rows: [{ total: params[1] === "2026-11-05" ? 0 : 425 }] } as never;
      throw new Error("Unexpected SQL query in mocked HTTP test");
    });

    const { createDevAuthRouter } = await import("../routes/dev-auth");
    const { default: fleetRouter } = await import("../routes/fleet-intelligence");
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use(pinoHttp());
    app.use("/api", createDevAuthRouter());
    app.use("/api/logistics/fleet", fleetRouter);
    const server: Server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No loopback address");
      const base = "http://127.0.0.1:" + address.port;
      const headers = {
        Host: "dev-fleet.cstlogistic.co.id",
        "X-Forwarded-Host": "dev-fleet.cstlogistic.co.id",
        "X-Forwarded-Proto": "https",
      };
      const get = (route: string, cookie = "") =>
        originalFetch(base + route, {
          headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
          redirect: "manual",
        });
      const path = "/api/logistics/fleet/transactions?startDate=2026-11-01&endDate=2026-11-04&limit=5";
      expect((await get(path)).status).toBe(401);
      expect((await get("/api/logistics/fleet/vehicles")).status).toBe(401);
      expect((await get(path, "fleet_dev_google_session=synthetic-invalid")).status).toBe(401);
      expect(query).not.toHaveBeenCalled();

      const login = await originalFetch(base + "/api/auth/google-dev-exchange", {
        method: "POST",
        headers: {
          ...headers, Origin: ORIGIN, "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: jwt() }),
        redirect: "manual",
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie.startsWith("fleet_dev_google_session=")).toBe(true);
      expect((await get("/api/auth/user", cookie)).status).toBe(200);

      const vehicles = await get("/api/logistics/fleet/vehicles", cookie);
      expect(vehicles.status).toBe(200);
      const inventory = await vehicles.json() as { vehicles: Array<Record<string, unknown>> };
      expect(inventory.vehicles).toHaveLength(44);
      expect(inventory.vehicles.every(v => v.company_id === 1)).toBe(true);

      const transactions = await get(path, cookie);
      expect(transactions.status).toBe(200);
      const response = await transactions.json() as {
        transactions: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
        sourceStatus: Record<string, unknown>;
      };
      expect(response.transactions).toHaveLength(5);
      expect(response.summary.total).toBe(413);
      expect(response.summary.rental_fee_rows).toBe(413);
      expect(response.sourceStatus).toMatchObject({
        normalizedRows: 413, rawRows: 425,
        totalFilteredRows: 425, excludedByEligibility: 12,
        totalStoredRows: 425, firstAvailableDate: "2026-11-01",
        lastAvailableDate: "2026-11-04", state: "normalized",
      });
      for (const item of response.transactions) {
        expect(item).not.toHaveProperty("driver_phone");
        expect(item).not.toHaveProperty("gopay_reference_id");
        expect(item).not.toHaveProperty("raw_data");
      }
      // A future date filter is empty, but the full-company source was
      // already normalized. Never mislabel that state "raw_only".
      const future = await get(
        "/api/logistics/fleet/transactions?startDate=2026-11-05&endDate=2026-11-17&limit=5",
        cookie,
      );
      expect(future.status).toBe(200);
      const futureData = await future.json() as {
        transactions: Array<Record<string, unknown>>;
        sourceStatus: Record<string, unknown>;
        summary: Record<string, unknown>;
      };
      expect(futureData.transactions).toHaveLength(0);
      expect(futureData.summary.total).toBe(0);
      expect(futureData.sourceStatus).toMatchObject({
        totalFilteredRows: 0, excludedByEligibility: 0,
        totalStoredRows: 425, firstAvailableDate: "2026-11-01",
        lastAvailableDate: "2026-11-04", state: "normalized",
      });

      expect(query).toHaveBeenCalled();
      for (const call of query.mock.calls) {
        const sql = String(call[0]);
        expect(sql).not.toMatch(/\b(?:INSERT INTO|DELETE FROM|UPDATE public\.)\b/i);
        expect(sql).not.toContain("SELECT *\n         FROM public.fleet_transactions");
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
  });
});
