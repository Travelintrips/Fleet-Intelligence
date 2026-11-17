import { describe, expect, it } from "vitest";
import { fleetTransactionPageState } from "./fleet-transaction-pagination";

describe("Fleet Transactions pagination uses the filtered total", () => {
  it("keeps Next enabled through page 16, then stops at page 17 of 413 / 25", () => {
    expect(fleetTransactionPageState(413, 16, 25)).toMatchObject({
      totalPages: 17, hasPrevious: true, hasNext: true,
    });
    expect(fleetTransactionPageState(413, 17, 25)).toMatchObject({
      totalPages: 17, hasPrevious: true, hasNext: false,
    });
  });

  it("disables Next on a full last page: 400 / 25 = exactly 16 pages", () => {
    expect(fleetTransactionPageState(400, 15, 25).hasNext).toBe(true);
    expect(fleetTransactionPageState(400, 16, 25)).toMatchObject({
      totalPages: 16, hasPrevious: true, hasNext: false,
    });
  });

  it("adapts correctly when the page size changes to 10 or 50", () => {
    expect(fleetTransactionPageState(413, 42, 10).hasNext).toBe(false);
    expect(fleetTransactionPageState(413, 41, 10).hasNext).toBe(true);
    expect(fleetTransactionPageState(413, 8, 50).hasNext).toBe(true);
    expect(fleetTransactionPageState(413, 9, 50)).toMatchObject({
      totalPages: 9, hasNext: false,
    });
  });

  it("handles empty filters and first-page controls without empty pages", () => {
    expect(fleetTransactionPageState(0, 1, 25)).toEqual({
      total: 0, totalPages: 1, hasPrevious: false, hasNext: false,
    });
    expect(fleetTransactionPageState("1", 1, 25)).toMatchObject({
      total: 1, totalPages: 1, hasPrevious: false, hasNext: false,
    });
  });

  it("does not enable Next on invalid totals or out-of-range pages", () => {
    expect(fleetTransactionPageState("not a number", 1, 25).hasNext).toBe(false);
    expect(fleetTransactionPageState(-1, 1, 25).hasNext).toBe(false);
    expect(fleetTransactionPageState(413, 18, 25).hasNext).toBe(false);
  });
});
