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
    status: rows.length === 0 ? "unavailable" as const : mismatches.length === 0 ? "ok" as const : "warn" as const,
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

/**
 * Finance release assessment, never a posting instruction.
 *
 * Operational CSV import and raw-vs-normalized parity do not depend on a bank
 * mutation. GL posting requires an independently approved vehicle-rental
 * contract, real Company 3 account mapping and a period/replay gate.
 */
export function assessGojekFinanceReadiness(
  composition: ReturnType<typeof describeGojekSourceComposition>,
  parity: ReturnType<typeof verifyGojekSourceParity>,
) {
  const supportedCategories = new Set<GojekRentalCategory>([
    "rental_fee_due", "rental_fee_deduction", "driver_rental_rebate",
  ]);
  const unknownRows = composition.categories
    .filter(group => !supportedCategories.has(group.category))
    .reduce((sum, group) => sum + group.rowCount, 0);
  return {
    sourceCompanyId: 1,
    financeCompanyId: 3,
    sourceParityStatus: parity.status,
    supportedSourceTypes: ["Rental fee due", "Rental fee deduction", "Rental Rebate to Driver - Rental Rebate"],
    unknownRows,
    pendingApprovals: [
      "company3_vehicle_rental_revenue_coa",
      "company3_driver_receivable_and_gojek_clearing_contract",
      "company3_rebate_treatment",
      "finance_period_and_idempotency_gate",
    ],
    requiresBankSettlementForCsvImport: false as const,
    sourceReadyForClassification: parity.status === "ok" && unknownRows === 0,
    postingReady: false as const,
    releaseDecision: "NO_GO" as const,
    explanation: "Source parity does not approve accounting accounts or prove cash settlement. Do not use tenant-rental revenue or bank cash as a substitute.",
  };
}
