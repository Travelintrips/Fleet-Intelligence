import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-level regression tests: these do NOT replace DB concurrency/E2E tests.
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
  it("exposes explicit sync failure and WA hold diagnostics", () => {
    expect(route).toContain("waHoldReason");
    expect(route).toContain("SYNC_FAILED");
    expect(route).toContain("SYNC_NOT_COMPLETED");
    expect(route).toContain("SYNC_NOT_FOUND");
  });
});
