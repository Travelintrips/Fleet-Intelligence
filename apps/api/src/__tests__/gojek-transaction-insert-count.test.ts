import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routes = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const importer = routes.split("async function importGojekConnectorCsv(")[1]
  ?.split("async function importDriverSnapshotConnectorCsv(")[0];

describe("GoCar Transactions import counter follows actual PostgreSQL inserts", () => {
  it("keeps normalized transaction dedup and counts only INSERT RETURNING rows", () => {
    expect(importer).toBeDefined();
    expect(importer).toContain("const normalizedInsert = await client.query<{ id: number }>(");
    expect(importer).toMatch(/INSERT INTO public\.fleet_transactions\([\s\S]*?ON CONFLICT DO NOTHING\s+RETURNING id`/);
    expect(importer).toContain("if (normalizedInsert.rows.length === 1) successRows += 1;");
    expect(importer).not.toContain("await client.query(\n          `INSERT INTO public.fleet_transactions(");
  });

  it("retains raw GoPay dedup, report-hash guard, and failed-row handling", () => {
    expect(importer).toContain("pg_advisory_xact_lock");
    expect(importer).toContain("AND file_hash=$2");
    expect(importer).toContain("INSERT INTO public.gojek_raw_transactions(");
    expect(importer).toContain("ON CONFLICT DO NOTHING RETURNING id");
    expect(importer).toContain("if (!raw.rows[0]?.id) continue");
    expect(importer).toContain("INSERT INTO public.gojek_failed_rows(");
    expect(importer).toContain("failedRows += 1");
    expect(importer).toContain("processed_count=$3,error_count=$4");
  });
});
