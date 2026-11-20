/**
 * Fleet Gojek rental accounting proposal for Company 3 (PT Diva Servis).
 *
 * This module has NO database writes or HTTP side effects. It is a DEV QA
 * planning contract, NOT a tax determination or posting authorization.
 * Source fleet_transactions remain owned by operational Company 1.
 */
export const GOJEK_RENTAL_COA_CODES = Object.freeze({
  gojekClearing: "1-1025-DV",
  driverRentalReceivable: "1-1035-DV",
  vehicleRentalRevenue: "4-1026-DV",
  rentalRebateContraRevenue: "4-1027-DV",
});
export type GojekRentalEventType =
  | "Rental fee due"
  | "Rental fee deduction"
  | "Rental Rebate to Driver - Rental Rebate";

export type GojekRentalSourceEvent = {
  sourceCompanyId: number;
  financeCompanyId: number;
  transactionId: number;
  reportId: number;
  transactionType: string;
  signedAmount: number;
  transactionDate: string;
  providerReferenceId?: string | null;
};

type DraftLine = { coaCode: string; debit: number; credit: number };

export function buildGojekRentalJournalPreview(source: GojekRentalSourceEvent) {
  if (source.sourceCompanyId !== 1 || source.financeCompanyId !== 3) {
    throw new Error("Gojek rental accounting must preserve source Company 1 and target Finance Diva Company 3.");
  }
  if (!Number.isSafeInteger(source.transactionId) || source.transactionId <= 0 ||
      !Number.isSafeInteger(source.reportId) || source.reportId <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(source.transactionDate)) {
    throw new Error("Gojek rental immutable source identity/date invalid.");
  }
  const signedCents = Math.round(source.signedAmount * 100);
  if (!Number.isFinite(source.signedAmount) || !Number.isSafeInteger(signedCents) ||
      signedCents === 0 || Math.abs(source.signedAmount * 100 - signedCents) > 0.0001) {
    throw new Error("Gojek rental event amount must be nonzero, precise to two decimals.");
  }
  const amount = Math.abs(signedCents) / 100;
  let debit: string, credit: string;
  switch (source.transactionType as GojekRentalEventType) {
    case "Rental fee due":
      if (signedCents <= 0) throw new Error("Rental fee due must be positive.");
      debit = GOJEK_RENTAL_COA_CODES.driverRentalReceivable;
      credit = GOJEK_RENTAL_COA_CODES.vehicleRentalRevenue;
      break;
    case "Rental fee deduction":
      if (signedCents >= 0) throw new Error("Rental fee deduction must be negative.");
      debit = GOJEK_RENTAL_COA_CODES.gojekClearing;
      credit = GOJEK_RENTAL_COA_CODES.driverRentalReceivable;
      break;
    case "Rental Rebate to Driver - Rental Rebate":
      if (signedCents >= 0) throw new Error("Rental rebate must be negative.");
      debit = GOJEK_RENTAL_COA_CODES.rentalRebateContraRevenue;
      credit = GOJEK_RENTAL_COA_CODES.driverRentalReceivable;
      break;
    default:
      throw new Error("Unclassified Gojek event type. Review the source CSV before accounting.");
  }

  const lines: DraftLine[] = [
    { coaCode: debit, debit: amount, credit: 0 },
    { coaCode: credit, debit: 0, credit: amount },
  ];
  const eventKey = `gojek-rental:1:${source.transactionId}`;
  return {
    eventKey,
    sourceCompanyId: 1 as const,
    financeCompanyId: 3 as const,
    sourceReportId: source.reportId,
    sourceTransactionId: source.transactionId,
    sourceType: source.transactionType as GojekRentalEventType,
    transactionDate: source.transactionDate,
    providerReferenceId: source.providerReferenceId ?? null,
    signedAmount: signedCents / 100,
    journalType: "noncash_rental_event_preview" as const,
    lines,
    totalDebit: amount,
    totalCredit: amount,
    isBankSettlement: false as const,
    postingAllowed: false as const,
    taxTreatment: "requires_contract_and_finance_approval" as const,
    rebateTreatment: source.transactionType === "Rental Rebate to Driver - Rental Rebate"
      ? "proposed_receivable_reduction_pending_confirmation" as const : null,
  };
}

/**
 * The source ID is the canonical dedupe identity, including rows with no
 * provider reference. Conflicting replays fail closed; identical replays
 * yield one preview, never an additional accounting entry.
 */
export function deduplicateGojekRentalPreviews(events: GojekRentalSourceEvent[]) {
  const seen = new Map<string, ReturnType<typeof buildGojekRentalJournalPreview>>();
  for (const event of events) {
    const preview = buildGojekRentalJournalPreview(event);
    const prior = seen.get(preview.eventKey);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(preview)) {
        throw new Error("Conflicting replay for the same Fleet Gojek source transaction ID.");
      }
      continue;
    }
    seen.set(preview.eventKey, preview);
  }
  return [...seen.values()];
}
