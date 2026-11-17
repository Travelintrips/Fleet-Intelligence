import { afterEach, describe, expect, it } from "vitest";
import {
  fleetTransactionQueryParams,
  initialFleetTransactionDateRange,
  toLocalCalendarDate,
} from "./fleet-transaction-date";

const originalTimezone = process.env.TZ;

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe("Fleet Transactions local calendar dates", () => {
  it("uses 17 November at 00:30 WIB even while the UTC calendar is 16 November", () => {
    process.env.TZ = "Asia/Jakarta";
    const now = new Date("2026-11-16T17:30:00.000Z");
    expect(now.toISOString().slice(0, 10)).toBe("2026-11-16");
    expect(toLocalCalendarDate(now)).toBe("2026-11-17");
    expect(initialFleetTransactionDateRange(now)).toEqual({
      startDate: "2026-10-18",
      endDate: "2026-11-17",
    });
  });

  it("keeps 30 calendar days across the local midnight and year boundary", () => {
    process.env.TZ = "Asia/Jakarta";
    expect(initialFleetTransactionDateRange(
      new Date("2026-12-31T17:15:00.000Z"),
    )).toEqual({ startDate: "2026-12-02", endDate: "2027-01-01" });
    expect(toLocalCalendarDate(
      new Date("2026-11-16T16:59:59.000Z"),
    )).toBe("2026-11-16");
    expect(toLocalCalendarDate(
      new Date("2026-11-16T17:00:00.000Z"),
    )).toBe("2026-11-17");
  });

  it("uses the viewer's actual local calendar, not hard-coded Asia/Jakarta", () => {
    process.env.TZ = "UTC";
    expect(initialFleetTransactionDateRange(
      new Date("2026-11-16T17:30:00.000Z"),
    )).toEqual({ startDate: "2026-10-17", endDate: "2026-11-16" });
  });

  it("omits cleared date filters so the API receives NULL dates, not empty DATE casts", () => {
    const params = fleetTransactionQueryParams({
      startDate: "", endDate: "", page: 2, pageSize: 25,
    });
    expect(params.has("startDate")).toBe(false);
    expect(params.has("endDate")).toBe(false);
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("25");
  });

  it("preserves explicit date bounds, driver search and vehicle filter", () => {
    const params = fleetTransactionQueryParams({
      startDate: "2026-11-01", endDate: "2026-11-04",
      page: 1, pageSize: 50,
      driverSearch: "driver test", vehiclePlate: "B 1234 XX",
    });
    expect(params.get("startDate")).toBe("2026-11-01");
    expect(params.get("endDate")).toBe("2026-11-04");
    expect(params.get("driverSearch")).toBe("driver test");
    expect(params.get("vehiclePlate")).toBe("B 1234 XX");
  });
});
