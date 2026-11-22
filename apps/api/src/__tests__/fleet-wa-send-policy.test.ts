import { describe, expect, it } from "vitest";
import { fleetSendIdempotencyKey, shouldSuppressFleetSend } from "../lib/fleet-wa-send-policy";

describe("Fleet manual vs automatic WA rules", () => {
  it("keeps automatic daily suppression even after a previous automatic send", () => {
    expect(shouldSuppressFleetSend("auto", true)).toBe(true);
    expect(shouldSuppressFleetSend("auto", false)).toBe(false);
    expect(shouldSuppressFleetSend("auto", true, "approved-catchup")).toBe(false);
  });

  it("does not block confirmed admin sends after automatic or manual sends", () => {
    expect(shouldSuppressFleetSend("selected", true)).toBe(false);
    expect(shouldSuppressFleetSend("manual", true)).toBe(false);
  });

  it("uses one stable key per admin click but distinct keys for later clicks", () => {
    const base = { companyId: 1, outstandingId: 47, sendType: "selected" as const, todayWib: "2026-11-13" };
    const first = fleetSendIdempotencyKey({ ...base, manualRequestId: "request-1" });
    expect(first).toBe(fleetSendIdempotencyKey({ ...base, manualRequestId: "request-1" }));
    expect(first).not.toBe(fleetSendIdempotencyKey({ ...base, manualRequestId: "request-2" }));
    expect(() => fleetSendIdempotencyKey(base)).toThrow();
  });

  it("preserves automatic once-per-driver-per-day gateway keys", () => {
    const base = { companyId: 1, outstandingId: 47, sendType: "auto" as const, todayWib: "2026-11-13" };
    expect(fleetSendIdempotencyKey(base)).toBe(fleetSendIdempotencyKey(base));
    expect(fleetSendIdempotencyKey(base)).not.toBe(fleetSendIdempotencyKey({ ...base, todayWib: "2026-11-14" }));
  });
});
