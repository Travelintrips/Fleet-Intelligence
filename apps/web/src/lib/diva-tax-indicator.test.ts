import { describe, expect, it } from "vitest";
import { divaTaxIndicator, jakartaCalendarToday } from "./diva-tax-indicator";

const tax = (tax_status: string, tax_due_date: string | null, tax_renewed_on: string | null = null, tax_reminder_days: number | null = 30) =>
  ({tax_status,tax_due_date,tax_renewed_on,tax_reminder_days});

describe("Diva annual tax indicator", () => {
  it("uses calendar day in Jakarta across UTC midnight", () => {
    expect(jakartaCalendarToday(new Date("2026-11-26T18:00:00Z"))).toBe("2026-11-27");
  });
  it("marks expired Chery unpaid red", () => {
    expect(divaTaxIndicator(tax("unpaid","2026-06-20"),"2026-11-26").label).toBe("Lewat jatuh tempo");
    expect(divaTaxIndicator(tax("unpaid","2026-06-20"),"2026-11-26").tone).toBe("danger");
  });
  it("warns 30 days before due, including paid previous period", () => {
    expect(divaTaxIndicator(tax("paid_due_verified","2026-12-12","2025-12-12"),"2026-11-26").label).toBe("Pajak dekat");
    expect(divaTaxIndicator(tax("unpaid","2026-11-26"),"2026-11-26").detail).toBe("Jatuh tempo hari ini");
  });
  it("is not yet due when the date is more than reminder window away", () => {
    expect(divaTaxIndicator(tax("unpaid","2027-02-26"),"2026-11-26").label).toBe("Belum dibayar");
  });
  it("shows green paid only for verified unexpired due date", () => {
    expect(divaTaxIndicator(tax("paid_due_verified","2027-11-20","2026-11-20"),"2026-11-26")).toMatchObject({label:"Sudah dibayar",tone:"success"});
  });
  it("cannot claim a past period still paid even with old payment", () => {
    expect(divaTaxIndicator(tax("paid_due_verified","2026-11-20","2025-11-20"),"2026-11-26")).toMatchObject({label:"Lewat jatuh tempo",tone:"danger"});
  });
  it("keeps unknown next date explicit even when paid", () => {
    expect(divaTaxIndicator(tax("paid_late_due_unverified",null,"2026-11-17"),"2026-11-26")).toMatchObject({tone:"warning",label:"Sudah dibayar · perlu verifikasi"});
  });
  it("still warns for a near or expired due date when payment history is unrecorded", () => {
    expect(divaTaxIndicator(tax("unrecorded","2026-12-12"),"2026-11-26").label).toBe("Pajak dekat");
    expect(divaTaxIndicator(tax("unrecorded","2026-11-12"),"2026-11-26").label).toBe("Lewat jatuh tempo");
    expect(divaTaxIndicator(tax("unrecorded","2027-11-11"),"2026-11-26").label).toBe("Belum tercatat");
  });
  it("falls back to 30 day window and supports custom reminder", () => {
    expect(divaTaxIndicator(tax("due_soon","2027-01-03",null,null),"2026-12-05").label).toBe("Pajak dekat");
    expect(divaTaxIndicator(tax("unpaid","2027-01-03",null,7),"2026-12-05").label).toBe("Belum dibayar");
  });
  it("rejects nonsense dates rather than claiming an expiry", () => {
    expect(divaTaxIndicator(tax("unpaid","2026-02-30"),"2026-11-26").label).toBe("Belum dibayar");
  });
});
