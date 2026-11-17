/**
 * Source-only, read-only Fleet Vehicles evidence projection.
 * A vehicle row marked "active" is not proof of an active driver or dispatch permission.
 * Counts are source transaction RECORDS, not the sum of Gojek trip_count.
 */
export function fleetVehicleReadSql(hasTransactionTable: boolean): string {
  const fields = [
    "SELECT v.*, d.full_name AS driver_name, d.driver_external_id,",
    "d.status AS driver_status,",
    "d.source_present_in_latest_snapshot AS driver_in_latest_snapshot,",
    hasTransactionTable
      ? "COALESCE(activity.tx_count,0)::int AS tx_count, activity.last_transaction_date"
      : "0::int AS tx_count, NULL::date AS last_transaction_date",
    "FROM public.fleet_vehicles v",
    "LEFT JOIN public.fleet_drivers d",
    "ON d.id=v.driver_id AND d.company_id=v.company_id::text",
  ];
  const normalizedPlate = (expr: string) =>
    `upper(regexp_replace(coalesce(${expr},''),'[^[:alnum:]]','','g'))`;
  const activityJoin = hasTransactionTable ? [
    "LEFT JOIN (",
    "SELECT t.company_id,",
    `${normalizedPlate("t.vehicle_plate")} AS plate_key,`,
    "COUNT(*)::int AS tx_count, MAX(t.transaction_date) AS last_transaction_date",
    "FROM public.fleet_transactions t",
    "WHERE t.company_id=$1 AND NULLIF(BTRIM(t.vehicle_plate),'') IS NOT NULL",
    `AND NULLIF(${normalizedPlate("t.vehicle_plate")},'') IS NOT NULL`,
    "GROUP BY t.company_id,",
    normalizedPlate("t.vehicle_plate"),
    ") activity ON activity.company_id=v.company_id",
    `AND activity.plate_key=${normalizedPlate("v.plate")}`,
  ] : [];
  return [
    ...fields, ...activityJoin,
    "WHERE v.company_id=$1", "ORDER BY v.plate ASC", "LIMIT $2",
  ].join("\n");
}

export interface FleetVehicleEvidenceInput {
  status?: unknown;
  driver_id?: unknown;
  driver_status?: unknown;
  driver_in_latest_snapshot?: unknown;
  tx_count?: unknown;
  last_transaction_date?: unknown;
}

function utcDateKey(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const matched = /^\d{4}-\d{2}-\d{2}(?:T|$)/.exec(value);
  return matched ? matched[0].slice(0, 10) : null;
}

/** This is evidence *for review only*; never a dispatch or work authorization. */
export function withFleetVehicleEvidence<T extends Record<string, unknown>>(
  vehicle: T,
  today: Date = new Date(),
): T & { needs_review: boolean; review_reasons: string[] } {
  const data: FleetVehicleEvidenceInput = vehicle;
  const reasons: string[] = [];
  if (data.status !== "active") reasons.push("Status kendaraan tidak aktif");
  if (data.driver_id === null || data.driver_id === undefined) {
    reasons.push("Driver belum ditetapkan");
  } else if (data.driver_status === "suspended") {
    reasons.push("Driver ditangguhkan");
  } else if (data.driver_status !== "active") {
    reasons.push("Status driver tidak aktif atau belum terverifikasi");
  }
  if (data.driver_in_latest_snapshot !== true) {
    reasons.push("Driver tidak ada pada snapshot Gojek terbaru");
  }
  const count = Number(data.tx_count);
  const dateKey = utcDateKey(data.last_transaction_date);
  if (!Number.isInteger(count) || count <= 0 || !dateKey) {
    reasons.push("Belum ada transaksi kendaraan yang terverifikasi");
  } else {
    const lastDate = new Date(`${dateKey}T00:00:00.000Z`);
    const validDate = !Number.isNaN(lastDate.getTime()) &&
      lastDate.toISOString().slice(0, 10) === dateKey;
    const todayUtc = new Date(Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
    ));
    const cutoff = new Date(todayUtc);
    cutoff.setUTCDate(cutoff.getUTCDate() - 30);
    if (!validDate || lastDate < cutoff || lastDate > todayUtc) {
      reasons.push("Tidak ada transaksi dalam 30 hari terakhir");
    }
  }
  return { ...vehicle, needs_review: reasons.length > 0, review_reasons: reasons };
}
