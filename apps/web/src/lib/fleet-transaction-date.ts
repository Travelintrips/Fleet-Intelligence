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
