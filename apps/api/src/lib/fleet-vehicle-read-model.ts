/**
 * Additive read-only Fleet vehicle projection.
 * tx_count counts transaction records (not Gojek trips).
 * last_transaction_date is activity evidence (not driver login).
 * Both source and transaction rows are scoped to signed company $1.
 */
export function fleetVehicleReadSql(hasTransactionTable: boolean): string {
  const fields = [
    "SELECT v.*, d.full_name AS driver_name, d.driver_external_id,",
    "d.status AS driver_status,",
    hasTransactionTable
      ? "COALESCE(activity.tx_count,0)::int AS tx_count, activity.last_transaction_date"
      : "0::int AS tx_count, NULL::date AS last_transaction_date",
    "FROM public.fleet_vehicles v",
    "LEFT JOIN public.fleet_drivers d",
    "ON d.id=v.driver_id AND d.company_id=v.company_id::text",
  ];
  const activityJoin = hasTransactionTable ? [
    "LEFT JOIN (",
    "SELECT t.company_id,",
    "upper(regexp_replace(coalesce(t.vehicle_plate,''),'[^[:alnum:]]','','g')) AS plate_key,",
    "COUNT(*)::int AS tx_count, MAX(t.transaction_date) AS last_transaction_date",
    "FROM public.fleet_transactions t",
    "WHERE t.company_id=$1 AND NULLIF(BTRIM(t.vehicle_plate),'') IS NOT NULL",
    "GROUP BY t.company_id,",
    "upper(regexp_replace(coalesce(t.vehicle_plate,''),'[^[:alnum:]]','','g'))",
    ") activity ON activity.company_id=v.company_id",
    "AND activity.plate_key=upper(regexp_replace(coalesce(v.plate,''),'[^[:alnum:]]','','g'))",
  ] : [];
  return [
    ...fields, ...activityJoin,
    "WHERE v.company_id=$1", "ORDER BY v.plate ASC", "LIMIT $2",
  ].join("\n");
}
