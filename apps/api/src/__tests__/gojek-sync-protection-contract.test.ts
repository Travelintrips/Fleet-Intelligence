import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-level regression tests: these do NOT replace DB concurrency/E2E tests.
const reminder = readFileSync(fileURLToPath(new URL("../lib/fleet-wa-reminder.ts", import.meta.url)), "utf8");
const alerts = readFileSync(fileURLToPath(new URL("../lib/fleet-alerts.ts", import.meta.url)), "utf8");
const route = readFileSync(fileURLToPath(new URL("../routes/fleet-intelligence.ts", import.meta.url)), "utf8");
const claim = route.split('router.post("/gojek-connector/worker/claim"')[1]?.split('router.post("/gojek-connector/worker/handoff"')[0] ?? "";
const handoff = route.split('router.post("/gojek-connector/worker/handoff"')[1]?.split('router.post("/gojek-connector/worker/fail"')[0] ?? "";

describe("Gojek sync safety contracts", () => {
  it("caps stale job recovery and records exhaustion", () => {
    expect(claim).toContain("RETRY_EXHAUSTED");
    expect(claim).toContain("Recovered stale running job");
    expect(claim).toContain("THEN 'failed' ELSE 'pending'");
  });
  it("claims pending jobs under a row lock", () => {
    expect(claim).toContain("FOR UPDATE SKIP LOCKED");
  });
  it("holds and releases the same advisory lock for each handoff", () => {
    expect(handoff).toContain("pg_try_advisory_lock");
    expect(handoff).toContain("pg_advisory_unlock");
    expect(handoff).toContain("lockClient.release()");
    expect(handoff).toContain('res.status(409)');
  });
  it("refuses handoff for jobs not running on the authenticated worker", () => {
    expect(handoff).toContain("AND worker_id=$2");
    expect(handoff).toContain('row.status !== "running"');
  });
  it("holds automatic WA unless today\'s scheduled driver snapshot succeeded", () => {
    expect(reminder).toContain("fleet-scheduler-0100-wib:");
    expect(reminder).toContain("Reminder ditunda: sinkronisasi Gojek hari ini belum berhasil");
  });
  it("creates one deduplicated admin alert for missing or failed daily sync", () => {
    expect(alerts).toContain("gojek_sync_failed");
    expect(alerts).toContain("ON CONFLICT (company_id,alert_type,reference_type,reference_id)");
    expect(alerts).toContain("auto_resolved_at=now()");
  });
  it("commits the import and job success on the same locked PostgreSQL connection", () => {
    expect(handoff).toContain('await lockClient.query("BEGIN")');
    expect(handoff).toContain('LIMIT 1 FOR UPDATE');
    expect(handoff.match(/client: lockClient/g)?.length).toBe(2);
    expect(handoff).toContain('await lockClient.query("COMMIT")');
    expect(handoff).toContain('await lockClient.query("ROLLBACK")');
    expect(handoff).toContain("finalized.rowCount !== 1");
    expect(route).toContain('if (!args.client) await client.query("COMMIT")');
    expect(route).toContain('if (!args.client) await client.query("ROLLBACK")');
    expect(route).toContain('await (args.client ?? pool).query');
  });
  it("exposes explicit sync failure and WA hold diagnostics", () => {
    expect(route).toContain("waHoldReason");
    expect(route).toContain("SYNC_FAILED");
    expect(route).toContain("SYNC_NOT_COMPLETED");
    expect(route).toContain("SYNC_NOT_FOUND");
  });
});
