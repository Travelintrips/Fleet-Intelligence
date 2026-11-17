/** Local calendar dates for Fleet UI date pickers (never UTC ISO dates). */
export function toLocalCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Capture one clock instant so both default endpoints share the same date. */
export function initialFleetTransactionDateRange(now: Date = new Date()) {
  const start = new Date(now.getTime());
  start.setDate(start.getDate() - 30);
  return {
    startDate: toLocalCalendarDate(start),
    endDate: toLocalCalendarDate(now),
  };
}

type FleetTransactionQuery = {
  startDate: string;
  endDate: string;
  page: number;
  pageSize: number;
  driverSearch?: string;
  vehiclePlate?: string;
};

/** Empty dates must be omitted: PostgreSQL cannot cast '' to DATE. */
export function fleetTransactionQueryParams({
  startDate, endDate, page, pageSize, driverSearch, vehiclePlate,
}: FleetTransactionQuery): URLSearchParams {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(pageSize),
  });
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (driverSearch) params.set("driverSearch", driverSearch);
  if (vehiclePlate) params.set("vehiclePlate", vehiclePlate);
  return params;
}
