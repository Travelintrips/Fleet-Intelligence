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

export interface GojekSourceParityRow {
  report_id: number | string;
  transaction_type: string | null;
  raw_rows: number | string;
  normalized_rows: number | string;
  raw_amount: number | string;
  normalized_amount: number | string;
}

/**
 * Checks amount and row-count parity per report and original transaction type,
 * not merely a net total that could mask two offsetting missing events.
 */
export function verifyGojekSourceParity(rows: GojekSourceParityRow[]) {
  const mismatches = rows.filter(row =>
    Number(row.raw_rows) !== Number(row.normalized_rows) ||
    Math.round(Number(row.raw_amount) * 100) !== Math.round(Number(row.normalized_amount) * 100),
  );
  return {
    status: mismatches.length === 0 ? "ok" as const : "warn" as const,
    groupsChecked: rows.length,
    mismatchedGroups: mismatches.length,
    mismatches: mismatches.map(row => ({
      reportId: Number(row.report_id),
      transactionType: row.transaction_type,
      rawRows: Number(row.raw_rows),
      normalizedRows: Number(row.normalized_rows),
      rawAmount: Number(row.raw_amount),
      normalizedAmount: Number(row.normalized_amount),
    })),
    note: "Read-only CSV-vs-Fleet parity by report and original event type. Not an accounting journal or bank settlement check.",
  };
}
