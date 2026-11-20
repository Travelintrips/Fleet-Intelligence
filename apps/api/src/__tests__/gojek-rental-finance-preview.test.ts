import { describe, expect, it } from "vitest";
import { buildGojekRentalJournalPreview, deduplicateGojekRentalPreviews, GOJEK_RENTAL_COA_CODES as coa } from "../lib/gojek-rental-finance-preview";

const due = {
  sourceCompanyId: 1, financeCompanyId: 3, transactionId: 3, reportId: 2,
  transactionType: "Rental fee due", signedAmount: 5000,
  transactionDate: "2026-11-04", providerReferenceId: null,
};
const deduction = {
  sourceCompanyId: 1, financeCompanyId: 3, transactionId: 2, reportId: 2,
  transactionType: "Rental fee deduction", signedAmount: -5000,
  transactionDate: "2026-11-04", providerReferenceId: "0620261104050204mQXZOq0cN7ID",
};

describe("Gojek vehicle rental Company1 -> Finance Diva Company3 DEV mapping", () => {
  it("models due as driver rental AR debit and dedicated vehicle rental revenue credit", () => {
    const plan = buildGojekRentalJournalPreview(due);
    expect(plan.eventKey).toBe("gojek-rental:1:3");
    expect(plan.lines).toEqual([
      {coaCode:coa.driverRentalReceivable,debit:5000,credit:0},
      {coaCode:coa.vehicleRentalRevenue,debit:0,credit:5000},
    ]);
    expect(plan.totalDebit).toBe(plan.totalCredit);
    expect(plan.providerReferenceId).toBeNull();
    expect(plan.postingAllowed).toBe(false);
  });
  it("models a Gojek deduction as clearing debit and driver receivable credit, never bank cash", () => {
    const plan=buildGojekRentalJournalPreview(deduction);
    expect(plan.lines).toEqual([
      {coaCode:coa.gojekClearing,debit:5000,credit:0},
      {coaCode:coa.driverRentalReceivable,debit:0,credit:5000},
    ]);
    expect(plan.isBankSettlement).toBe(false);
    expect(plan.postingAllowed).toBe(false);
    const combined=[...buildGojekRentalJournalPreview(due).lines,...plan.lines];
    expect(combined.filter(l=>l.coaCode===coa.driverRentalReceivable).reduce((x,l)=>x+l.debit-l.credit,0)).toBe(0);
    expect(combined.reduce((x,l)=>x+l.debit-l.credit,0)).toBe(0);
  });
  it("models a rebate only as a proposal for contra revenue against driver AR, not cash", () => {
    const plan=buildGojekRentalJournalPreview({
      ...due, transactionId: 99999, transactionType:"Rental Rebate to Driver - Rental Rebate",
      signedAmount:-200,
    });
    expect(plan.lines).toEqual([
      {coaCode:coa.rentalRebateContraRevenue,debit:200,credit:0},
      {coaCode:coa.driverRentalReceivable,debit:0,credit:200},
    ]);
    expect(plan.rebateTreatment).toBe("proposed_receivable_reduction_pending_confirmation");
    expect(plan.postingAllowed).toBe(false);
    expect(plan.taxTreatment).toBe("requires_contract_and_finance_approval");
  });
  it("deduplicates identical replay without provider reference", () => {
    const plans=deduplicateGojekRentalPreviews([due,deduction,{...due}]);
    expect(plans.map(p=>p.eventKey)).toEqual(["gojek-rental:1:3","gojek-rental:1:2"]);
    expect(plans.length).toBe(2);
  });
  it("rejects a conflicting replay for the same source transaction", () => {
    expect(()=>deduplicateGojekRentalPreviews([due,{...due,signedAmount:5001}])).toThrow(/Conflicting replay/);
    expect(()=>deduplicateGojekRentalPreviews([due,{...due,transactionType:"Rental fee deduction",signedAmount:-5000}])).toThrow(/Conflicting replay/);
  });
  it("fails closed for wrong company or inconsistent event sign", () => {
    expect(()=>buildGojekRentalJournalPreview({...due,sourceCompanyId:3})).toThrow(/source Company 1/);
    expect(()=>buildGojekRentalJournalPreview({...due,financeCompanyId:1})).toThrow(/Finance Diva Company 3/);
    expect(()=>buildGojekRentalJournalPreview({...due,signedAmount:-5000})).toThrow(/must be positive/);
    expect(()=>buildGojekRentalJournalPreview({...deduction,signedAmount:5000})).toThrow(/must be negative/);
    expect(()=>buildGojekRentalJournalPreview({...due,transactionType:"Unverified new type"})).toThrow(/Unclassified/);
  });
  it("blocks zero, fractional-cent, or invalid source IDs", () => {
    expect(()=>buildGojekRentalJournalPreview({...due,signedAmount:0})).toThrow(/nonzero/);
    expect(()=>buildGojekRentalJournalPreview({...due,signedAmount:5000.001})).toThrow(/two decimals/);
    expect(()=>buildGojekRentalJournalPreview({...due,transactionId:0})).toThrow(/identity/);
  });
});
