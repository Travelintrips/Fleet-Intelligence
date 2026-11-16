import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const dryRun = source.split('router.post("/gojek-connector/dry-run"')[1]
  ?.split('router.post("/gojek-connector/handoff"')[0];
const handoff = source.split('router.post("/gojek-connector/handoff"')[1]
  ?.split('router.get("/gojek-connector/runtime-credentials"')[0];

describe("Gojek CSV validation errors are client errors, not server faults", () => {
  it("maps malformed headers and unclosed CSV quotes to a typed format error", () => {
    expect(source).toContain("class FleetCsvValidationError extends Error");
    expect(source).toContain('throw new FleetCsvValidationError("CSV memiliki kutip yang tidak tertutup.")');
    expect(source).toContain('throw new FleetCsvValidationError("CSV wajib memiliki kolom Driver Name dan Outstanding.")');
    expect(source).toContain('throw new FleetCsvValidationError("CSV transaksi wajib memiliki kolom Driver Name dan Amount.")');
  });

  it("reports malformed CSV as 400 in private dry-run without writing records", () => {
    expect(dryRun).toBeDefined();
    expect(dryRun).toContain("if (error instanceof FleetCsvValidationError)");
    expect(dryRun).toContain("res.status(400).json({ error: error.message })");
    expect(dryRun).toContain('database: "ready"');
    expect(dryRun).toContain("persisted: false");
    expect(dryRun).toContain('getGojekConnectorConfig()');
    expect(dryRun).toContain('connectorSecretMatches(req.get("x-gojek-connector-secret"))');
  });

  it("preserves official handoff dedup/409 and scopes format rejection to HTTP 400", () => {
    expect(handoff).toBeDefined();
    expect(handoff).toContain("error instanceof FleetCsvValidationError ? 400");
    expect(handoff).toContain('message.includes("sudah pernah") ? 409 : 500');
    expect(handoff).toContain("importGojekConnectorCsv({");
    expect(handoff).toContain("importDriverSnapshotConnectorCsv({");
  });
});
