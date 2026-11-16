/** Read-only Fleet inventory evidence; never a dispatch or driver authorization. */
export type FleetEvidenceStatus = "corroborated" | "review" | "unknown";
export type FleetEvidenceReason =
  | "driver_not_active"
  | "snapshot_missing"
  | "no_transactions"
  | "stale_transaction"
  | "transactions_unavailable"
  | "transaction_date_invalid"
  | null;

export type FleetVehicleEvidence = {
  evidence_status: FleetEvidenceStatus;
  evidence_reason: FleetEvidenceReason;
};

export type FleetVehicleEvidenceInput = {
  driverStatus: unknown;
  snapshotPresent: unknown;
  transactionCount: unknown;
  lastTransactionDate: unknown;
};

function dateKey(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value.trim());
  if (!match) return null;
  const key = match[1];
  const parsed = new Date(key + "T00:00:00.000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) return null;
  return key;
}

function jakartaDateKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const segment = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return segment("year") + "-" + segment("month") + "-" + segment("day");
}

export function assessFleetVehicleEvidence(
  input: FleetVehicleEvidenceInput,
  at: Date = new Date(),
): FleetVehicleEvidence {
  const review = (reason: Exclude<FleetEvidenceReason, null>): FleetVehicleEvidence =>
    ({ evidence_status: "review", evidence_reason: reason });
  const unknown = (reason: Exclude<FleetEvidenceReason, null>): FleetVehicleEvidence =>
    ({ evidence_status: "unknown", evidence_reason: reason });

  if (input.driverStatus !== "active") return review("driver_not_active");
  if (input.snapshotPresent !== true) return review("snapshot_missing");
  if (input.transactionCount === null || input.transactionCount === undefined)
    return unknown("transactions_unavailable");

  const count = Number(input.transactionCount);
  if (!Number.isSafeInteger(count) || count < 0) return unknown("transactions_unavailable");
  if (count === 0) return review("no_transactions");

  const lastDate = dateKey(input.lastTransactionDate);
  if (!lastDate || Number.isNaN(at.getTime())) return unknown("transaction_date_invalid");
  const today = jakartaDateKey(at);
  if (lastDate > today) return unknown("transaction_date_invalid");

  const threshold = new Date(today + "T00:00:00.000Z");
  threshold.setUTCDate(threshold.getUTCDate() - 30);
  if (lastDate < threshold.toISOString().slice(0, 10))
    return review("stale_transaction");

  return { evidence_status: "corroborated", evidence_reason: null };
}
