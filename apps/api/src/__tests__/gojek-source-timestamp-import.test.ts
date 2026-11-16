import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import pinoHttp from "pino-http";
import type { Server } from "node:http";

const seen: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
    connect: vi.fn(async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        seen.push({ sql, params });
        if (sql.includes("SELECT id,original_filename,status FROM public.fleet_reports"))
          return { rows: [] };
        if (sql.includes("INSERT INTO public.fleet_reports"))
          return { rows: [{ id: 991001 }] };
        if (sql.includes("INSERT INTO public.gojek_raw_transactions"))
          return { rows: [{ id: 991002 + seen.filter(q => q.sql.includes("INSERT INTO public.gojek_raw_transactions")).length }] };
        if (sql.includes("INSERT INTO public.fleet_transactions"))
          return { rows: [{ id: 991010 }] };
        return { rows: [] };
      },
      release: () => undefined,
    })),
  },
}));

describe("Official Gojek Date & Time(JKT) event fidelity in canonical importer", () => {
  afterEach(() => {
    for (const key of [
      "APP_ENV", "GOJEK_CONNECTOR_ENABLED", "GOJEK_CONNECTOR_SHARED_SECRET",
      "GOJEK_CONNECTOR_COMPANY_ID",
    ]) delete process.env[key];
    seen.length = 0;
  });

  it("retains distinct event times for no-GoPay same-day deductions", async () => {
    process.env.APP_ENV = "development";
    process.env.GOJEK_CONNECTOR_ENABLED = "true";
    process.env.GOJEK_CONNECTOR_SHARED_SECRET = "synthetic_no_real_connector_secret";
    process.env.GOJEK_CONNECTOR_COMPANY_ID = "1";
    const { default: router } = await import("../routes/fleet-intelligence");
    const app = express();
    app.use(express.json());
    app.use(pinoHttp());
    app.use("/api/logistics/fleet", router);
    const server: Server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Loopback listener unavailable");
      const sourceCsv = [
        "Date & Time(JKT),Driver ID,Driver Name,Phone Number,Vehicle,Amount,Total Outstanding Balance,Type,GoPay Transaction Reference ID,Date",
        "4/11/2026 12:02:08,FAKE-DRIVER,FICTITIOUS,00000,SYN001,0,0,Rental fee deduction,,4/11/2026",
        "4/11/2026 12:03:11,FAKE-DRIVER,FICTITIOUS,00000,SYN001,0,0,Rental fee deduction,,4/11/2026",
      ].join("\n");
      const result = await fetch(
        `http://127.0.0.1:${addr.port}/api/logistics/fleet/gojek-connector/handoff`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gojek-connector-secret": "synthetic_no_real_connector_secret",
          },
          body: JSON.stringify({ fileName: "fictional-official-format.csv", content: sourceCsv }),
        },
      );
      expect(result.status).toBe(201);
      expect(await result.json()).toMatchObject({
        ok: true, exportType: "transactions", rowCount: 2,
        rawInserted: 2, successRows: 2, failedRows: 0, status: "done",
      });
      const raw = seen.filter(({ sql }) =>
        sql.includes("INSERT INTO public.gojek_raw_transactions"));
      expect(raw).toHaveLength(2);
      expect(raw.map(({ params }) => params[2])).toEqual([
        "4/11/2026 12:02:08", "4/11/2026 12:03:11",
      ]);
      expect(raw.map(({ params }) => params[14])).toEqual([
        "2026-11-04", "2026-11-04",
      ]);
      const normalized = seen.filter(({ sql }) =>
        sql.includes("INSERT INTO public.fleet_transactions"));
      expect(normalized.map(({ params }) => params[5])).toEqual([
        "2026-11-04", "2026-11-04",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
  });
});
