/**
 * Read-only description of the Gojek rental events present in Fleet.
 * Deliberately NOT a GL posting rule: contract ownership, settlement
 * evidence and company mapping must be approved separately by Finance.
 */
export type GojekRentalCategory =
  | "rental_fee_due"
  | "rental_fee_deduction"
  | "driver_rental_rebate"
  | "unclassified";

export function classifyGojekRentalType(type: unknown): GojekRentalCategory {
  switch (String(type ?? "").trim()) {
    case "Rental fee due": return "rental_fee_due";
    case "Rental fee deduction": return "rental_fee_deduction";
    case "Rental Rebate to Driver - Rental Rebate": return "driver_rental_rebate";
    default: return "unclassified";
  }
}

export interface GojekSourceGroup {
  transaction_type: string | null;
  row_count: number | string;
  signed_amount: number | string;
  reference_count: number | string;
  missing_reference_count: number | string;
}

export function describeGojekSourceComposition(groups: GojekSourceGroup[]) {
  return {
    source: "fleet_transactions",
    postingReady: false as const,
    bankSettlementProven: false as const,
    caveat: "Gojek rental ledger source is not evidence of bank settlement; per-company chart mapping and approved journal custody remain separate.",
    categories: groups.map(group => ({
      originalTransactionType: group.transaction_type,
      category: classifyGojekRentalType(group.transaction_type),
      rowCount: Number(group.row_count),
      signedAmount: Number(group.signed_amount),
      providerReferenceCount: Number(group.reference_count),
      missingProviderReferenceCount: Number(group.missing_reference_count),
    })),
  };
}
