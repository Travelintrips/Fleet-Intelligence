import { describe, expect, it } from "vitest";
import { classifyGojekRentalType, describeGojekSourceComposition } from "../lib/fleet-gojek-source-composition";

describe("Gojek rental source classification is read-only evidence", () => {
  it("preserves exact CSV event semantics instead of booking all rows as trip revenue", () => {
    expect(classifyGojekRentalType("Rental fee due")).toBe("rental_fee_due");
    expect(classifyGojekRentalType("Rental fee deduction")).toBe("rental_fee_deduction");
    expect(classifyGojekRentalType("Rental Rebate to Driver - Rental Rebate")).toBe("driver_rental_rebate");
    expect(classifyGojekRentalType("Unknown new GoPartner type")).toBe("unclassified");
  });

  it("keeps signed totals and provider-reference coverage separate and does not infer bank settlement", () => {
    const evidence = describeGojekSourceComposition([
      {transaction_type:"Rental fee due",row_count:43,signed_amount:"1155000.00",reference_count:0,missing_reference_count:43},
      {transaction_type:"Rental fee deduction",row_count:67,signed_amount:"-1143415.00",reference_count:47,missing_reference_count:20},
    ]);
    expect(evidence.postingReady).toBe(false);
    expect(evidence.bankSettlementProven).toBe(false);
    expect(evidence.categories).toEqual([
      {originalTransactionType:"Rental fee due",category:"rental_fee_due",rowCount:43,signedAmount:1155000,providerReferenceCount:0,missingProviderReferenceCount:43},
      {originalTransactionType:"Rental fee deduction",category:"rental_fee_deduction",rowCount:67,signedAmount:-1143415,providerReferenceCount:47,missingProviderReferenceCount:20},
    ]);
  });

  it("does not reinterpret a driver rebate or future unknown type as cash received", () => {
    const evidence=describeGojekSourceComposition([
      {transaction_type:"Rental Rebate to Driver - Rental Rebate",row_count:2,signed_amount:"-3489640",reference_count:0,missing_reference_count:2},
      {transaction_type:"Other",row_count:1,signed_amount:"999",reference_count:0,missing_reference_count:1},
    ]);
    expect(evidence.categories.map(x=>x.category)).toEqual(["driver_rental_rebate","unclassified"]);
    expect(evidence.postingReady).toBe(false);
    expect(evidence.bankSettlementProven).toBe(false);
  });
});
