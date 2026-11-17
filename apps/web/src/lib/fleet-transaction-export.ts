import { fleetTransactionQueryParams } from "./fleet-transaction-date";

const PAGE_LIMIT = 200; // API hard-caps limit at 200.
const MAX_EXPORT_ROWS = 20_000;

export type FleetExportRow = Record<string, unknown>;

export type FleetExportFilters = {
  startDate: string;
  endDate: string;
  driverSearch?: string;
  vehiclePlate?: string;
};

type TransactionPage = {
  transactions: FleetExportRow[];
  summary: { total: number | string };
};

/**
 * Read every eligible row that matches the current UI filters, not just the
 * visible 10/25/50 rows. Never silently return an incomplete or changing set.
 * Uses the existing authenticated, company-scoped GET endpoint only.
 */
export async function getAllFilteredFleetTransactions(
  filters: FleetExportFilters,
  fetchImpl: typeof fetch = fetch,
): Promise<FleetExportRow[]> {
  const collected: FleetExportRow[] = [];
  const uniqueIds = new Set<string>();
  let expectedTotal: number | null = null;

  for (let page = 1; page <= Math.ceil(MAX_EXPORT_ROWS / PAGE_LIMIT); page += 1) {
    const params = fleetTransactionQueryParams({
      ...filters,
      page,
      pageSize: PAGE_LIMIT,
    });
    const response = await fetchImpl(`/api/logistics/fleet/transactions?${params}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Fleet Transactions HTTP ${response.status}; ekspor dibatalkan`);
    }

    const payload = await response.json() as TransactionPage;
    const total = Number(payload.summary?.total);
    if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(payload.transactions)) {
      throw new Error("Respons transaksi tidak valid; ekspor dibatalkan");
    }
    if (total > MAX_EXPORT_ROWS) {
      throw new Error(`Hasil filter melebihi batas aman ekspor ${MAX_EXPORT_ROWS} baris`);
    }
    if (expectedTotal === null) expectedTotal = total;
    if (total !== expectedTotal) {
      throw new Error("Jumlah transaksi berubah selama ekspor; ulangi dengan filter yang sama");
    }
    if (payload.transactions.length > PAGE_LIMIT) {
      throw new Error("Halaman transaksi melebihi batas API; ekspor dibatalkan");
    }
    for (const row of payload.transactions) {
      if (typeof row !== "object" || row === null) {
        throw new Error("Baris transaksi tidak valid; ekspor dibatalkan");
      }
      const id = String(row.id ?? "");
      if (!id || uniqueIds.has(id)) {
        throw new Error("Transaksi duplikat atau tanpa ID saat ekspor; ulangi ekspor");
      }
      uniqueIds.add(id);
      collected.push(row);
    }
    if (collected.length > expectedTotal) {
      throw new Error("Transaksi melebihi ringkasan filter; ekspor dibatalkan");
    }
    if (collected.length === expectedTotal) return collected;
    if (payload.transactions.length === 0) {
      throw new Error("Sebagian transaksi gagal diambil; file CSV tidak dibuat");
    }
  }
  throw new Error("Ekspor tidak lengkap setelah mencapai batas halaman");
}

function csvCell(value: unknown, userText = false): string {
  let cell = String(value ?? "");
  // Quoting alone does not prevent spreadsheet formula injection in text.
  // Leave signed financial columns untouched so -amount remains numeric.
  if (userText && /^[\s\u0000-\u001f]*[=+\-@]/.test(cell)) {
    cell = "'" + cell;
  }
  return `"${cell.replace(/"/g, '""')}"`;
}

/** The same column order and fee-ledger labels as the existing export. */
export function buildFleetTransactionsCsv(
  transactions: FleetExportRow[],
  feeLedgerOnly: boolean,
): string {
  const headers = [
    "Tanggal", "Nama Driver", "Plat", "Layanan", "Trip",
    feeLedgerOnly ? "Tagihan Sewa" : "Gross Revenue",
    "Insentif", "Komisi", "Potongan",
    feeLedgerOnly ? "Nilai Biaya Sewa" : "Net Revenue",
    "Outstanding", "PPN Rate", "PPN Amount",
  ];
  const values = transactions.map(t => [
    csvCell(t.transaction_date, true),
    csvCell(t.driver_name, true),
    csvCell(t.vehicle_plate, true),
    csvCell(t.service_type, true),
    csvCell(t.trip_count),
    csvCell(t.gross_revenue),
    csvCell(t.incentive),
    csvCell(t.commission),
    csvCell(t.deduction),
    csvCell(t.net_revenue),
    csvCell(t.outstanding_balance),
    csvCell(t.ppn_rate),
    csvCell(t.ppn_amount),
  ].join(","));
  return "\uFEFF" + [headers.map(v => csvCell(v)).join(","), ...values].join("\r\n");
}
