import { DatePicker } from "@/components/ui/date-picker";
import { initialFleetTransactionDateRange, fleetTransactionQueryParams } from "@/lib/fleet-transaction-date";
import { buildFleetTransactionsCsv, getAllFilteredFleetTransactions } from "@/lib/fleet-transaction-export";
import { fleetTransactionPageState } from "@/lib/fleet-transaction-pagination";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Receipt, Download, Search, X, ArrowLeft, UploadCloud, Database } from "lucide-react";
import { Link } from "wouter";

function fmtIdr(v: unknown) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(parseFloat(String(v ?? 0)) || 0);
}
function fmtNum(v: unknown) {
  return new Intl.NumberFormat("id-ID").format(parseFloat(String(v ?? 0)) || 0);
}
function fmtSourceDate(date: string) {
  // Server returns a calendar date, not a local timestamp.
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("id-ID", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

export default function FleetTransactionsPage() {
  // Both defaults come from one browser-local calendar date, not UTC ISO.
  const [defaultRange] = useState(() => initialFleetTransactionDateRange());
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [driverSearch, setDriverSearch] = useState("");
  const [vehiclePlate, setVehiclePlate] = useState("");
  const [driverSearchApplied, setDriverSearchApplied] = useState("");
  const [vehiclePlateApplied, setVehiclePlateApplied] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportedCount, setExportedCount] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["fleet-transactions", startDate, endDate, page, pageSize, driverSearchApplied, vehiclePlateApplied],
    queryFn: async () => {
      const params = fleetTransactionQueryParams({
        startDate, endDate, page, pageSize,
        driverSearch: driverSearchApplied,
        vehiclePlate: vehiclePlateApplied,
      });
      const res = await fetch(`/api/logistics/fleet/transactions?${params}`, { credentials: "include" });
      // An expired Google session is not an empty transaction report.
      if (!res.ok) throw new Error(`Fleet Transactions HTTP ${res.status}`);
      return res.json() as Promise<{
        transactions: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
        sourceStatus?: {
          normalizedRows: number; rawRows: number; totalFilteredRows?: number;
          excludedByEligibility?: number; totalStoredRows?: number;
          firstAvailableDate?: string | null; lastAvailableDate?: string | null;
          state: "normalized" | "raw_only" | "no_source_data";
        };
      }>;
    },
  });

  const transactions = data?.transactions ?? [];
  const summary = data?.summary ?? {};
  const pagination = fleetTransactionPageState(summary.total, page, pageSize);
  const sourceStatus = data?.sourceStatus;
  const noSourceData = sourceStatus?.state === "no_source_data";
  const hasSourceCoverage = Boolean(sourceStatus?.firstAvailableDate && sourceStatus?.lastAvailableDate);
  const beyondLastStoredDate = hasSourceCoverage && endDate > String(sourceStatus?.lastAvailableDate);
  const excludedRows = Math.max(0, Number(sourceStatus?.excludedByEligibility ?? 0));
  const feeLedgerOnly = Number(summary.total ?? 0) > 0
    && Number(summary.rental_fee_rows ?? 0) === Number(summary.total ?? 0);

  function applyFilters() {
    setDriverSearchApplied(driverSearch);
    setVehiclePlateApplied(vehiclePlate);
    setPage(1);
  }

  function clearFilters() {
    setDriverSearch("");
    setVehiclePlate("");
    setDriverSearchApplied("");
    setVehiclePlateApplied("");
    setPage(1);
  }

  const hasActiveFilters = driverSearchApplied || vehiclePlateApplied;

  async function exportCsv() {
    if (isExporting || isLoading || isError) return;
    setIsExporting(true);
    setExportError("");
    setExportedCount(null);
    try {
      const rows = await getAllFilteredFleetTransactions({
        startDate, endDate,
        driverSearch: driverSearchApplied,
        vehiclePlate: vehiclePlateApplied,
      });
      // Avoid offering a complete-looking CSV if the displayed count went stale.
      if (rows.length !== Number(summary.total ?? 0)) {
        throw new Error("Jumlah transaksi berubah sejak halaman dibuka; muat ulang lalu ekspor kembali");
      }
      const csv = buildFleetTransactionsCsv(rows, feeLedgerOnly);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `fleet_transactions_${startDate || "semua"}_${endDate || "semua"}.csv`;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setExportedCount(rows.length);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Gagal mengekspor transaksi");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <Link href="/logistics/fleet-intelligence">
          <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white gap-1.5 -ml-2">
            <ArrowLeft className="w-4 h-4" /> Fleet Intelligence
          </Button>
        </Link>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Transaksi Fleet</h1>
            <p className="text-slate-400 text-sm mt-1">Rincian transaksi harian per driver</p>
          </div>
          <Button
            variant="outline" size="sm" className="gap-2 border-slate-600"
            onClick={() => void exportCsv()}
            disabled={isExporting || isLoading || isError || Number(summary.total ?? 0) === 0}
          >
            <Download className="w-4 h-4" />
            {isExporting ? "Menyiapkan CSV..." : "Export CSV (semua hasil filter)"}
          </Button>
        </div>

        {exportError && (
          <p role="alert" className="text-sm text-amber-200">
            Ekspor CSV dibatalkan: {exportError}. Tidak ada file parsial dibuat.
          </p>
        )}
        {exportedCount !== null && (
          <p role="status" className="text-sm text-slate-400">
            CSV berisi {fmtNum(exportedCount)} transaksi driver aktif sesuai filter, bukan hanya halaman yang sedang terlihat.
          </p>
        )}

        {/* Filter */}
        <Card className="bg-slate-800/60 border-slate-700">
          <CardContent className="p-4">
            <div className="flex flex-wrap gap-4 items-end">
              <div className="space-y-1.5">
                <Label className="text-slate-300 text-sm">Tanggal Mulai</Label>
                <DatePicker value={startDate} onChange={(v) => { setStartDate(v); setPage(1); }} className="bg-slate-700 border-slate-600 text-white" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-300 text-sm">Tanggal Akhir</Label>
                <DatePicker value={endDate} onChange={(v) => { setEndDate(v); setPage(1); }} className="bg-slate-700 border-slate-600 text-white" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-300 text-sm">Cari Driver</Label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Nama driver..."
                    value={driverSearch}
                    onChange={(e) => setDriverSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                    className="bg-slate-700 border-slate-600 text-white pl-8 w-44"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-300 text-sm">Plat Kendaraan</Label>
                <Input
                  placeholder="Plat..."
                  value={vehiclePlate}
                  onChange={(e) => setVehiclePlate(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                  className="bg-slate-700 border-slate-600 text-white w-32"
                />
              </div>
              <div className="flex gap-2 pb-0.5">
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-700 gap-1.5"
                  onClick={applyFilters}
                >
                  <Search className="w-3.5 h-3.5" /> Filter
                </Button>
                {hasActiveFilters && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-slate-600 gap-1.5"
                    onClick={clearFilters}
                  >
                    <X className="w-3.5 h-3.5" /> Reset
                  </Button>
                )}
              </div>
            </div>
            {hasActiveFilters && (
              <div className="mt-3 flex gap-2 flex-wrap">
                {driverSearchApplied && (
                  <span className="text-xs px-2 py-1 bg-blue-500/20 border border-blue-600/40 rounded text-blue-300">
                    Driver: "{driverSearchApplied}"
                  </span>
                )}
                {vehiclePlateApplied && (
                  <span className="text-xs px-2 py-1 bg-blue-500/20 border border-blue-600/40 rounded text-blue-300">
                    Plat: "{vehiclePlateApplied}"
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {isError && (
          <Card className="bg-slate-800/60 border-slate-700">
            <CardContent className="p-4 text-sm text-slate-200">
              Data transaksi belum dapat dibaca. Periksa sesi Google Fleet DEV; ini bukan bukti bahwa tidak ada transaksi.
            </CardContent>
          </Card>
        )}

        {/* Date coverage refers to all company-scoped stored source rows, not
            only active drivers or the currently selected date/filter range. */}
        {hasSourceCoverage && !isError && (
          <Card className="bg-slate-800/60 border-slate-700">
            <CardContent className="p-4 text-sm text-slate-200">
              <span className="font-semibold">Periode data tersimpan: </span>
              {fmtSourceDate(String(sourceStatus?.firstAvailableDate))} – {fmtSourceDate(String(sourceStatus?.lastAvailableDate))}
              {" · "}{fmtNum(sourceStatus?.totalStoredRows)} transaksi sumber.
              {beyondLastStoredDate && (
                <p className="mt-1 text-amber-200">
                  Belum ada transaksi Fleet DEV yang tersimpan setelah {fmtSourceDate(String(sourceStatus?.lastAvailableDate))}.
                  Ini tidak berarti tidak ada transaksi lebih baru di sumber Gojek.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {noSourceData && (
          <Card className="border-amber-500/20 bg-amber-500/[0.055]">
            <CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-400/20 bg-amber-400/10">
                  <Database className="h-4 w-4 text-amber-300" />
                </div>
                <div>
                  <div className="font-semibold text-slate-100">Belum ada data transaksi Gojek</div>
                  <p className="mt-1 max-w-2xl text-sm text-slate-400">
                    Fleet belum menerima report transaksi. Upload report Gojek agar data otomatis masuk ke raw transaction, dinormalisasi, lalu tampil di Transactions dan Analytics.
                  </p>
                </div>
              </div>
              <Link href="/logistics/fleet-intelligence/upload">
                <Button className="shrink-0 gap-2">
                  <UploadCloud className="h-4 w-4" /> Upload Report
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {sourceStatus?.state === "raw_only" && (
          <Card className="border-blue-500/20 bg-blue-500/[0.045]">
            <CardContent className="p-4 text-sm text-blue-200">
              Raw transaction tersedia ({fmtNum(sourceStatus.rawRows)} baris), tetapi belum ada transaksi normalized pada filter/periode ini.
            </CardContent>
          </Card>
        )}

        {/* Historical sources are kept in the ledger even when active eligibility filters hide them. */}
        {excludedRows > 0 && (
          <Card className="border-amber-500/20 bg-amber-500/[0.055]">
            <CardContent className="p-4 text-sm text-amber-200">
              {fmtNum(excludedRows)} transaksi sumber pada periode/filter ini tersimpan, tetapi tidak tampil sebagai transaksi driver aktif karena status driver, snapshot, atau identitas kendaraan perlu ditinjau. Transaksi tidak dihapus dan driver tidak diaktifkan otomatis.
            </CardContent>
          </Card>
        )}
        {feeLedgerOnly && (
          <Card className="border-blue-500/20 bg-blue-500/[0.045]">
            <CardContent className="p-4 text-sm text-blue-200">
              Data pada periode/filter ini merupakan Rental fee due dan Rental fee deduction (biaya sewa), bukan pendapatan perjalanan GoCar. Angka bersih di bawah adalah pergerakan biaya sewa driver yang memenuhi filter aktif, bukan omzet perjalanan atau laba perusahaan.
            </CardContent>
          </Card>
        )}

        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Transaksi", value: fmtNum(summary.total) },
            { label: "Total Trip", value: fmtNum(summary.total_trips) },
            { label: feeLedgerOnly ? "Pergerakan Biaya Sewa Bersih" : "Total Net Revenue", value: fmtIdr(feeLedgerOnly ? summary.rental_fee_signed_net : summary.total_net) },
            { label: feeLedgerOnly ? "Tagihan Biaya Sewa" : "Total Gross Revenue", value: fmtIdr(feeLedgerOnly ? summary.rental_fee_due_total : summary.total_gross) },
          ].map((s) => (
            <Card key={s.label} className="bg-slate-800/60 border-slate-700">
              <CardContent className="p-4">
                <div className="text-lg font-bold text-white">{s.value}</div>
                <div className="text-xs text-slate-400 mt-0.5">{s.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Table */}
        <Card className="bg-slate-800/60 border-slate-700">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-700">
                  <tr>
                    {["Tanggal", "Driver", "Plat", "Layanan", "Trip", feeLedgerOnly ? "Tagihan Sewa" : "Gross", "Insentif", "Komisi", "Potongan", feeLedgerOnly ? "Biaya Sewa Bersih" : "Net Revenue", "Outstanding", "PPN"].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-slate-400 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {isLoading
                    ? Array.from({ length: 10 }).map((_, i) => (
                        <tr key={i} className="border-b border-slate-700/50">
                          <td colSpan={12} className="px-4 py-3"><div className="h-4 bg-slate-700 rounded animate-pulse" /></td>
                        </tr>
                      ))
                    : transactions.length === 0 ? (
                        <tr>
                          <td colSpan={12} className="px-4 py-12 text-center text-slate-500">
                            <Receipt className="w-10 h-10 mx-auto mb-2 opacity-40" />
                            <p>{isError ? "Gagal memuat transaksi" : noSourceData ? "Belum ada report transaksi yang diproses" : "Tidak ada transaksi di periode ini"}</p>
                            {hasActiveFilters && !noSourceData && <p className="text-xs mt-1">Coba ubah atau hapus filter</p>}
                            {noSourceData && (
                              <Link href="/logistics/fleet-intelligence/upload">
                                <Button size="sm" variant="outline" className="mt-4 gap-2"><UploadCloud className="h-3.5 w-3.5" /> Upload Report</Button>
                              </Link>
                            )}
                          </td>
                        </tr>
                      )
                    : transactions.map((t, i) => (
                        <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                          <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">{String(t.transaction_date)}</td>
                          <td className="px-4 py-2.5 text-white font-medium max-w-[140px] truncate" title={String(t.driver_name ?? "")}>{String(t.driver_name ?? "-")}</td>
                          <td className="px-4 py-2.5 text-slate-400">{String(t.vehicle_plate ?? "-")}</td>
                          <td className="px-4 py-2.5 text-slate-400">{String(t.service_type ?? "-")}</td>
                          <td className="px-4 py-2.5 text-right text-slate-300">{fmtNum(t.trip_count)}</td>
                          <td className="px-4 py-2.5 text-right text-slate-300">{fmtIdr(t.gross_revenue)}</td>
                          <td className="px-4 py-2.5 text-right text-yellow-400">{fmtIdr(t.incentive)}</td>
                          <td className="px-4 py-2.5 text-right text-red-400">{fmtIdr(t.commission)}</td>
                          <td className="px-4 py-2.5 text-right text-red-400">{fmtIdr(t.deduction)}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-emerald-400">{fmtIdr(t.net_revenue)}</td>
                          <td className="px-4 py-2.5 text-right text-amber-400">{fmtIdr(t.outstanding_balance)}</td>
                          <td className="px-4 py-2.5 text-right text-slate-500 text-xs">{String(t.ppn_amount && Number(t.ppn_amount) > 0 ? fmtIdr(t.ppn_amount) : "—")}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
              <span className="text-slate-400 text-sm">{fmtNum(summary.total)} total transaksi</span>
              <div className="flex items-center gap-2">
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-300"
                  aria-label="Jumlah transaksi per halaman"
                >
                  <option value={10}>10 / halaman</option>
                  <option value={25}>25 / halaman</option>
                  <option value={50}>50 / halaman</option>
                </select>
                <Button variant="outline" size="sm" disabled={isLoading || isError || !pagination.hasPrevious} onClick={() => setPage((p) => p - 1)}>Prev</Button>
                <span className="px-3 py-1 text-slate-400 text-sm">Hal. {page} dari {pagination.totalPages}</span>
                <Button variant="outline" size="sm" disabled={isLoading || isError || !pagination.hasNext} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
