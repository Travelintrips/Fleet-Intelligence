import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/fleet-cash-db", () => ({ fleetCashPool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("../lib/central-finance-client", () => ({
  assertCentralFinanceWriteEnabled: vi.fn(),
  getFleetAccountingSettings: vi.fn(),
  postFleetCashPayment: vi.fn(),
  reverseFleetCashPayment: vi.fn(),
}));
import { fleetCashPool as pool } from "../lib/fleet-cash-db";
import { assertCentralFinanceWriteEnabled, getFleetAccountingSettings, postFleetCashPayment, reverseFleetCashPayment } from "../lib/central-finance-client";
import { createFleetCashPayment, retryFleetCashPayment, cancelFleetCashPayment } from "../lib/fleet-cash-payment-service";

const source = {
  id: 99, company_id: 1, driver_name: "Test Driver", amount: "50000.00",
  payment_date: "2026-11-17", reference_no: "TEST-99",
  outstanding_id: 5, accounting_entry_id: null, status: "confirmed",
};
const createArgs = { companyId: 1, driverName: "Test Driver", amount: 50000, paymentDate: "2026-11-17", actor: "tester" };

beforeEach(() => { vi.resetAllMocks(); });

describe("Fleet cash payment recovery and cancellation", () => {
  it("blocks every mutation before source or Finance access when writer is disabled", async () => {
    vi.mocked(assertCentralFinanceWriteEnabled).mockImplementation(() => { throw new Error("writer disabled"); });
    for (const operation of [
      () => createFleetCashPayment(createArgs),
      () => retryFleetCashPayment(1, 99, "tester"),
      () => cancelFleetCashPayment(1, 99, "tester"),
    ]) await expect(operation()).rejects.toThrow("writer disabled");
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(getFleetAccountingSettings).not.toHaveBeenCalled();
    expect(postFleetCashPayment).not.toHaveBeenCalled();
    expect(reverseFleetCashPayment).not.toHaveBeenCalled();
  });

  it("does not create a source payment if the mapped receiver preflight fails", async () => {
    vi.mocked(getFleetAccountingSettings).mockRejectedValue(new Error("Diva settings unavailable"));
    await expect(createFleetCashPayment(createArgs)).rejects.toThrow("Diva settings unavailable");
    expect(pool.connect).not.toHaveBeenCalled();
    expect(postFleetCashPayment).not.toHaveBeenCalled();
  });

  it("rejects an inactive receiver writer before recording an activated DEV payment", async () => {
    const before = { APP_ENV: process.env.APP_ENV, FLEET_CASH_DATABASE_ENABLED_DEV: process.env.FLEET_CASH_DATABASE_ENABLED_DEV };
    process.env.APP_ENV = "development";
    process.env.FLEET_CASH_DATABASE_ENABLED_DEV = "true";
    try {
      vi.mocked(getFleetAccountingSettings).mockResolvedValue({
        companyId: 3, sourceCompanyId: 1, fleetCashAccountId: 10,
        fleetDriverReceivableAccountId: 11, journalId: 12,
        receiverWriteEnabled: false, receiverWriteReady: false,
      } as never);
      await expect(createFleetCashPayment(createArgs)).rejects.toMatchObject({ status: 409 });
      expect(pool.connect).not.toHaveBeenCalled();
      expect(postFleetCashPayment).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it.each([0, -1, 1.001, Number.NaN])("rejects invalid amount %s before creating source rows", async (amount) => {
    await expect(createFleetCashPayment({ ...createArgs, amount })).rejects.toMatchObject({ status: 400 });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(getFleetAccountingSettings).not.toHaveBeenCalled();
  });

  it.each([
    { driver_name: "Another Driver", driver_external_id: "driver-1" },
    { driver_name: "Test Driver", driver_external_id: "another-driver-id" },
  ])("rejects an outstanding belonging to a different driver before source creation", async (outstanding) => {
    vi.mocked(getFleetAccountingSettings).mockResolvedValue({
      companyId: 3, sourceCompanyId: 1, fleetCashAccountId: 10,
      fleetDriverReceivableAccountId: 11, journalId: 12,
    } as never);
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("SELECT outstanding_amount") ? [{ ...outstanding, outstanding_amount: "100000.00" }] : [],
      rowCount: 1,
    }));
    const release = vi.fn();
    vi.mocked(pool.connect).mockResolvedValue({ query, release } as never);
    await expect(createFleetCashPayment({ ...createArgs, outstandingId: 5, driverExternalId: "driver-1" }))
      .rejects.toMatchObject({ status: 409, message: "Outstanding tidak sesuai dengan driver pembayaran." });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(postFleetCashPayment).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses to cancel a confirmed payment while remote posting is unresolved", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [source] } as never);
    await expect(cancelFleetCashPayment(1, 99, "tester")).rejects.toMatchObject({
      status: 409, details: { paymentRecorded: true, paymentId: 99, retryAvailable: true },
    });
    expect(reverseFleetCashPayment).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("refuses a posted label without an accounting link", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ ...source, status: "posted" }] } as never);
    await expect(cancelFleetCashPayment(1, 99, "tester")).rejects.toMatchObject({ status: 409 });
    expect(reverseFleetCashPayment).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("returns a recoverable existing ID after Finance response loss", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [source] } as never);
    vi.mocked(postFleetCashPayment).mockRejectedValue(new Error("response lost"));
    await expect(retryFleetCashPayment(1, 99, "tester")).rejects.toMatchObject({
      status: 503, details: { paymentId: 99, paymentRecorded: true, status: "confirmed", retryAvailable: true },
    });
    expect(postFleetCashPayment).toHaveBeenCalledWith({
      companyId: 1, paymentId: 99, amount: 50000, driverName: "Test Driver",
      paymentDate: "2026-11-17", referenceNo: "TEST-99", actor: "tester",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("does not create or debit again when retry finds source already posted", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ ...source, status: "posted", accounting_entry_id: 700 }] } as never);
    await expect(retryFleetCashPayment(1, 99, "tester")).resolves.toMatchObject({
      accountingEntryId: 700, idempotent: true,
    });
    expect(postFleetCashPayment).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("keeps retry and cancellation company-scoped", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    await expect(retryFleetCashPayment(2, 99, "tester")).rejects.toMatchObject({ status: 404 });
    await expect(cancelFleetCashPayment(2, 99, "tester")).rejects.toMatchObject({ status: 404 });
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [99, 2]);
    expect(postFleetCashPayment).not.toHaveBeenCalled();
    expect(reverseFleetCashPayment).not.toHaveBeenCalled();
  });

  it("rechecks settled source after concurrent retry and does not debit outstanding twice", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [source] } as never);
    vi.mocked(postFleetCashPayment).mockResolvedValue({ entryId: 700, idempotent: true, companyId: 3, sourceCompanyId: 1 });
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FOR UPDATE") ? [{ ...source, status: "posted", accounting_entry_id: 700 }] : [],
      rowCount: 1,
    }));
    const release = vi.fn();
    vi.mocked(pool.connect).mockResolvedValue({ query, release } as never);
    await expect(retryFleetCashPayment(1, 99, "tester")).resolves.toMatchObject({ accountingEntryId: 700, idempotent: true });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rechecks cancelled source after concurrent reversals and restores outstanding once", async () => {
    const posted = { ...source, status: "posted", accounting_entry_id: 700 };
    vi.mocked(pool.query).mockResolvedValue({ rows: [posted] } as never);
    vi.mocked(reverseFleetCashPayment).mockImplementation(async () => {
      expect(pool.connect).not.toHaveBeenCalled();
      return { entryId: 701, idempotent: true, companyId: 3, sourceCompanyId: 1 };
    });
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FOR UPDATE") ? [{ ...posted, status: "cancelled" }] : [],
      rowCount: 1,
    }));
    vi.mocked(pool.connect).mockResolvedValue({ query, release: vi.fn() } as never);
    await expect(cancelFleetCashPayment(1, 99, "tester")).resolves.toMatchObject({ idempotent: true, reversalEntryId: 701 });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
});
