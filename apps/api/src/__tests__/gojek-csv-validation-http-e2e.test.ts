import { describe, expect, it, vi } from "vitest";
import express from "express";
import pinoHttp from "pino-http";
import type { Server } from "node:http";

vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
    connect: vi.fn(() => { throw new Error("Unexpected DB writer call in parser HTTP test"); }),
  },
}));

describe("CST DEV private Gojek CSV route: HTTP behavior without database writes", () => {
  it("parses valid exports and rejects malformed CSV with 400", async () => {
    const secret = "synthetic_test_secret_not_a_deployed_credential";
    const keys = [
      "APP_ENV", "GOJEK_CONNECTOR_ENABLED", "GOJEK_CONNECTOR_SHARED_SECRET",
      "GOJEK_CONNECTOR_COMPANY_ID", "GOJEK_FLEET_PORTAL_URL",
      "GOJEK_CONNECTOR_ALLOWED_HOST",
    ] as const;
    const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      APP_ENV: "development",
      GOJEK_CONNECTOR_ENABLED: "true",
      GOJEK_CONNECTOR_SHARED_SECRET: secret,
      GOJEK_CONNECTOR_COMPANY_ID: "1",
      GOJEK_FLEET_PORTAL_URL: "https://fleetpartner.gojek.com",
      GOJEK_CONNECTOR_ALLOWED_HOST: "fleetpartner.gojek.com",
    });

    const { default: router } = await import("../routes/fleet-intelligence");
    const app = express();
    app.use(express.json());
    app.use(pinoHttp());
    app.use("/api/logistics/fleet", router);
    const server: Server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No loopback port");
      const base = `http://127.0.0.1:${address.port}/api/logistics/fleet/gojek-connector`;
      const post = (route: string, content: string, suppliedSecret = secret) =>
        fetch(base + route, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gojek-connector-secret": suppliedSecret,
          },
          body: JSON.stringify({ fileName: "synthetic.csv", content }),
        });

      const validTransactions = [
        "Driver Name,Driver ID,Date Time JKT,Vehicle,Amount,Transaction Type,GoPay Transaction Reference ID",
        "FICTITIOUS A,FA-001,2026-11-16 14:00:00,TEST-CAR-01,12000,synthetic,MOCK-REF-001",
        "FICTITIOUS B,FB-002,2026-11-16 14:01:00,TEST-CAR-02,18000,synthetic,MOCK-REF-002",
      ].join("\n");
      const tx = await post("/dry-run", validTransactions);
      expect(tx.status).toBe(200);
      expect(await tx.json()).toMatchObject({
        ok: true, dryRun: true, exportType: "transactions", rowCount: 2, persisted: false,
      });

      const validDrivers = [
        "Driver Name,Phone Number,License Plate,Rental fee(Daily),Outstanding,Status",
        "FICTITIOUS D,0000000000,TEST-CAR-03,5000,0,Active",
      ].join("\n");
      const drivers = await post("/dry-run", validDrivers);
      expect(drivers.status).toBe(200);
      expect(await drivers.json()).toMatchObject({
        ok: true, dryRun: true, exportType: "driver_snapshot", rowCount: 1, persisted: false,
      });

      const malformedHeader = "Bad Header,Not Amount\nFICTITIOUS,123";
      for (const path of ["/dry-run", "/handoff"]) {
        const res = await post(path, malformedHeader);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          error: "CSV transaksi wajib memiliki kolom Driver Name dan Amount.",
        });
      }

      const unclosedQuote = 'Driver Name,Amount\n"FICTITIOUS,1000';
      for (const path of ["/dry-run", "/handoff"]) {
        const res = await post(path, unclosedQuote);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          error: "CSV memiliki kutip yang tidak tertutup.",
        });
      }

      const empty = await post("/dry-run", "");
      expect(empty.status).toBe(400);
      const denied = await post("/dry-run", validTransactions, "invalid_test_secret");
      expect(denied.status).toBe(401);

      const { pool } = await import("../lib/db");
      const queryCalls = vi.mocked(pool.query).mock.calls;
      expect(queryCalls).toHaveLength(2);
      expect(queryCalls.every(([query]) => query === "SELECT 1")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
      for (const key of keys) {
        const value = old[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
