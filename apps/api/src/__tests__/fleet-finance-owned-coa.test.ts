import { describe, expect, it } from "vitest";
import { requireOwnedFleetAccountingSettings } from "../lib/central-finance-client";

describe("Fleet direct Finance settings: only verified same-company COA/journal IDs pass", () => {
  it("accepts complete valid company-scoped settings", () => {
    expect(requireOwnedFleetAccountingSettings({
      fleet_cash_account_id: 49097,
      fleet_driver_receivable_account_id: 49101,
      journal_id: 8195,
    })).toEqual({
      fleetCashAccountId: 49097,
      fleetDriverReceivableAccountId: 49101,
      journalId: 8195,
    });
  });
  it.each([
    [undefined, "missing company settings"],
    [{ fleet_cash_account_id: null, fleet_driver_receivable_account_id: 49101, journal_id: 8195 }, "missing/foreign/nonpostable cash"],
    [{ fleet_cash_account_id: 49097, fleet_driver_receivable_account_id: null, journal_id: 8195 }, "missing/foreign/nonpostable receivable"],
    [{ fleet_cash_account_id: 49097, fleet_driver_receivable_account_id: 49101, journal_id: null }, "missing/foreign/inactive journal"],
  ])("fails closed for %s (%s)", (row, _reason) => {
    expect(() => requireOwnedFleetAccountingSettings(row)).toThrow(/belum valid untuk perusahaan/);
  });
});
