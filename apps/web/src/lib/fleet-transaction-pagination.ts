/** UI pagination must use the server's filtered eligible total, not page length.
 * The API may return a full final page (e.g. 400 rows with limit 25).
 */
export function fleetTransactionPageState(
  totalValue: unknown,
  page: number,
  pageSize: number,
) {
  const parsedTotal = Number(totalValue ?? 0);
  const total = Number.isSafeInteger(parsedTotal) && parsedTotal >= 0
    ? parsedTotal
    : 0;
  const size = Number.isSafeInteger(pageSize) && pageSize > 0
    ? pageSize
    : 25;
  const totalPages = Math.max(1, Math.ceil(total / size));
  return {
    total,
    totalPages,
    hasPrevious: page > 1,
    hasNext: Number.isSafeInteger(page) && page > 0 && page < totalPages,
  };
}
