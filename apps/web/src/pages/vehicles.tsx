import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Car, Plus, ArrowLeft, FileText, Pencil } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { fleetVehicleEvidenceView } from "@/lib/fleet-vehicle-evidence";

function fmtDate(s: unknown) {
  if (!s) return "—";
  return new Date(String(s)).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

type Vehicle = Record<string, unknown>;

export default function FleetVehiclesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editTax, setEditTax] = useState<null | {
    plate: string; paidOn: string; dueOn: string; status: string; version: string; note: string;
  }>(null);

  const [form, setForm] = useState({ plate: "", vehicleType: "motor", brand: "", model: "", year: "", color: "", notes: "" });

  const { data, isLoading, isError } = useQuery({
    queryKey: ["fleet-vehicles"],
    queryFn: async () => {
      const res = await fetch("/api/logistics/fleet/vehicles", { credentials: "include" });
      if (!res.ok) throw new Error("Gagal membaca kendaraan Fleet (HTTP " + res.status + ")");
      return res.json() as Promise<{ vehicles: Vehicle[] }>;
    },
  });

  const { data: divaAssets, isLoading: isDivaLoading, isError: divaLoadError } = useQuery({
    queryKey: ["fleet-diva-assets"],
    queryFn: async () => {
      const res = await fetch("/api/logistics/fleet/vehicles/diva-assets", { credentials: "include" });
      if (res.status === 403 || res.status === 404) return null;
      if (!res.ok) throw new Error("Tidak dapat mengambil aset PT Diva Servis");
      return res.json() as Promise<{
        companyId: number;
        companyName: string;
        taxEditEnabled: boolean;
        assets: Array<{
          plate_number: string; brand: string; model: string; ownership_type: string; status: string;
          tax_document_id: number | null; tax_version: string | null;
          tax_renewed_on: string | null; tax_due_date: string | null; tax_status: string | null;
          tax_reminder_days: number | null;
        }>;
      }>;
    },
    retry: false,
  });

  const updateTax = useMutation({
    mutationFn: async (edit: NonNullable<typeof editTax>) => {
      const res = await fetch(
        `/api/logistics/fleet/vehicles/diva-assets/${encodeURIComponent(edit.plate)}/tax`,
        {
          method: "PATCH", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paidOn: edit.paidOn || null, dueOn: edit.dueOn || null,
            status: edit.status, version: edit.version, note: edit.note,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(body.error || "Gagal mengubah pajak kendaraan"));
      return body;
    },
    onSuccess: () => {
      toast.success("Data pajak berhasil diperbarui");
      setEditTax(null);
      qc.invalidateQueries({queryKey: ["fleet-diva-assets"]});
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/logistics/fleet/vehicles", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error("Gagal menambah kendaraan");
    },
    onSuccess: () => {
      toast.success("Kendaraan berhasil ditambahkan");
      setOpen(false);
      setForm({ plate: "", vehicleType: "motor", brand: "", model: "", year: "", color: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["fleet-vehicles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const vehicles = data?.vehicles ?? [];
  const total    = vehicles.length;
  const aktif    = vehicles.filter((v) => v.status === "active").length;
  const motor    = vehicles.filter((v) => String(v.vehicle_type ?? "motor") === "motor").length;
  const mobil    = vehicles.filter((v) => String(v.vehicle_type ?? "") === "car").length;
  const driverAktif = vehicles.length === 0 ? 0 : vehicles.every((v) => typeof v.driver_status === "string")
    ? vehicles.filter((v) => v.driver_status === "active").length : "—";
  const reviewNeeded = vehicles.length === 0 ? 0 : vehicles.every((v) => fleetVehicleEvidenceView(v).tone !== "unknown")
    ? vehicles.filter((v) => fleetVehicleEvidenceView(v).tone === "warning").length : "—";

  return (
    <AppShell>
      <div className="space-y-6">

        {/* Back link */}
        <Link href="/logistics/fleet-intelligence">
          <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white gap-1.5 -ml-2">
            <ArrowLeft className="w-4 h-4" /> Fleet Intelligence
          </Button>
        </Link>

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Kendaraan Fleet</h1>
            <p className="text-slate-400 text-sm mt-1">Data kendaraan dari armada &amp; CSV laporan Gojek</p>
          </div>
          <Button className="bg-blue-600 hover:bg-blue-700 gap-2" onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4" /> Tambah Kendaraan
          </Button>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          {[
            { label: "Total Kendaraan", value: total },
            { label: "Aktif Kendaraan", value: aktif },
            { label: "Driver Aktif", value: driverAktif },
            { label: "Perlu Review", value: reviewNeeded },
            { label: "Motor", value: motor },
            { label: "Mobil", value: mobil },
          ].map((s) => (
            <Card key={s.label} className="bg-slate-800/60 border-slate-700">
              <CardContent className="p-4 flex items-center gap-3">
                <Car className="w-6 h-6 text-blue-400 flex-shrink-0" />
                <div>
                  <div className="text-xl font-bold text-white">{s.value}</div>
                  <div className="text-xs text-slate-400">{s.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="text-xs text-amber-300">
          Status aktif adalah status kendaraan, bukan status driver dan bukan izin dispatch.
          Kolom transaksi menunjukkan jumlah catatan transaksi serta tanggal transaksi terakhir.
          Bukti data cocok bukan persetujuan operasional atau izin dispatch.
        </p>

        {isError && <p role="alert" className="text-sm text-rose-300">Gagal memuat data kendaraan Fleet. Coba muat ulang; status belum dapat diverifikasi.</p>}

        {/* Owner-only asset registry: separate from CST operational vehicles and evidence totals. */}
        {(isDivaLoading || divaAssets || divaLoadError) && (
          <Card className="bg-slate-900 border-slate-600 shadow-sm">
            <CardContent className="p-5 space-y-4">
              <h2 className="text-xl font-semibold text-white">Aset PT Diva Servis</h2>
              <p className="text-sm text-slate-200">
                Registri kepemilikan Company 3 (baca-saja). Tidak mengubah kendaraan,
                driver, transaksi, outstanding, atau izin operasional GoCar Company 1.
              </p>
              {isDivaLoading ? <p className="text-sm text-slate-400">Memuat aset...</p> : divaLoadError ? <p className="text-sm text-amber-300">Data aset belum dapat dibaca. Silakan periksa koneksi PROD.</p> : (
                <div className="overflow-x-auto rounded-md border border-slate-700">
                  <table className="w-full min-w-[1050px] table-auto text-sm">
                    <thead><tr className="bg-slate-800 text-left text-slate-100 uppercase tracking-wide">
                      <th className="px-3 py-3 pr-4 text-slate-100">Nomor polisi</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Merek / model</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Pemilik</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Status aset</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Pajak tahunan habis</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Perpanjangan pajak</th>
                      <th className="px-3 py-3">Ubah pajak</th>
                    </tr></thead>
                    <tbody>
                      {divaAssets?.assets.map(asset => (
                        <tr key={asset.plate_number} className="border-t border-slate-600 text-slate-100 odd:bg-slate-900 even:bg-slate-800/70">
                          <td className="px-3 py-3 pr-4 font-mono font-semibold text-white whitespace-nowrap">{asset.plate_number}</td>
                          <td className="px-3 py-3 pr-4 text-slate-100">{asset.brand} {asset.model}</td>
                          <td className="px-3 py-3 pr-4 text-slate-100">PT Diva Servis</td>
                          <td className="px-3 py-3 pr-4 text-slate-100">{asset.ownership_type === "own" ? "Milik perusahaan" : "Perlu verifikasi"} · {asset.status}</td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {asset.tax_due_date ? fmtDate(asset.tax_due_date) : "Jatuh tempo baru belum diverifikasi"}
                          </td>
                          <td className="px-3 py-3 pr-4 text-slate-100">
                            {asset.tax_status === "paid_late_due_unverified"
                              ? ((asset.plate_number === "B1649PNV" || asset.plate_number === "B1650PNV") && asset.tax_renewed_on === "2026-11-17")
                                ? `Sudah dibayar ${fmtDate(asset.tax_renewed_on)} (terlambat 6 hari dari jatuh tempo 11 Nov 2026). Tanggal pajak berikutnya belum diverifikasi.`
                                : `Sudah dibayar ${fmtDate(asset.tax_renewed_on)}; jatuh tempo baru belum diverifikasi.`
                              : asset.tax_status === "renewed_pending_proof"
                                ? `Dilaporkan diperpanjang ${fmtDate(asset.tax_renewed_on)}; bukti pembayaran perlu diperiksa`
                              : asset.tax_status === "due_soon"
                                ? "Belum diperpanjang"
                                : asset.tax_status === "paid_due_verified"
                                  ? `Sudah dibayar ${fmtDate(asset.tax_renewed_on)}; pajak berikutnya terverifikasi`
                                  : asset.tax_status === "unpaid"
                                    ? "Belum dibayar"
                                    : "Belum tercatat"}
                          </td>
                          <td className="py-2 whitespace-nowrap">
                            <Button variant="outline" size="sm"
                              disabled={!divaAssets?.taxEditEnabled || !asset.tax_document_id || !asset.tax_version}
                              onClick={() => setEditTax({
                                plate:asset.plate_number,paidOn:asset.tax_renewed_on || "",
                                dueOn:asset.tax_due_date || "",
                                status:asset.tax_status || "due_soon",
                                version:asset.tax_version || "",note:"",
                              })}>
                              <Pencil className="w-3 h-3 mr-1" /> {divaAssets?.taxEditEnabled ? "Edit Pajak" : "Edit (belum aktif)"}
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {divaAssets?.assets.length === 0 && (
                        <tr><td colSpan={7} className="py-3 text-slate-400">Belum ada aset terdaftar</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Table */}
        <Card className="bg-slate-800/60 border-slate-700">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-700">
                  <tr>
                    {["Plat", "Tipe", "Merk/Model", "Driver Terpasang", "Transaksi Terakhir", "Transaksi", "Sumber", "Status Kendaraan", "Bukti Data"].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-slate-400 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {isLoading
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i} className="border-b border-slate-700/50">
                          <td colSpan={9} className="px-4 py-3">
                            <div className="h-4 bg-slate-700 rounded animate-pulse" />
                          </td>
                        </tr>
                      ))
                    : isError ? (
                        <tr className="border-b border-slate-700/50"><td colSpan={9} className="px-4 py-10 text-center text-rose-300">Data kendaraan belum dapat dibaca; tidak menyimpulkan armada kosong.</td></tr>
                      ) : vehicles.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-16 text-center text-slate-500">
                            <Car className="w-10 h-10 mx-auto mb-3 opacity-40" />
                            <p>Belum ada data kendaraan</p>
                            <p className="text-xs mt-1">Upload laporan CSV Gojek untuk mengisi data otomatis</p>
                          </td>
                        </tr>
                      )
                    : vehicles.map((v, idx) => {
                        const isManual = v.is_manual === true;
                        const vehicleType = String(v.vehicle_type ?? "motor");
                        const brand = String(v.brand ?? "");
                        const model = String(v.model ?? "");
                        const brandModel = [brand, model].filter(Boolean).join(" / ") || "—";
                        const evidence = fleetVehicleEvidenceView(v);
                        return (
                          <tr key={String(v.plate ?? idx)} className="border-b border-slate-700/30 hover:bg-slate-700/20 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-white whitespace-nowrap">
                              {String(v.plate ?? "—")}
                            </td>
                            <td className="px-4 py-3 text-slate-300 capitalize whitespace-nowrap">
                              {vehicleType === "car" ? "Mobil" : vehicleType === "van" ? "Van" : "Motor"}
                            </td>
                            <td className="px-4 py-3 text-slate-300">{brandModel}</td>
                            <td className="px-4 py-3 text-slate-400 whitespace-nowrap max-w-[140px] truncate">
                              {String(v.driver_name ?? "—")}
                              <div className="text-xs mt-1 text-slate-500">{String(v.driver_status ?? "unknown") === "active" ? "Driver aktif" : String(v.driver_status ?? "unknown") === "suspended" ? "Driver suspended" : String(v.driver_status ?? "unknown") === "inactive" ? "Driver tidak aktif" : "Status driver belum terverifikasi"}</div>
                            </td>
                            <td className="px-4 py-3 text-slate-400 whitespace-nowrap text-xs">
                              {fmtDate(v.last_transaction_date)}
                            </td>
                            <td className="px-4 py-3 text-slate-400 text-right tabular-nums">
                              {v.tx_count != null ? Number(v.tx_count).toLocaleString("id-ID") : "—"}
                            </td>
                            <td className="px-4 py-3">
                              {isManual ? (
                                <Badge className="bg-blue-500/15 text-blue-300 border border-blue-700/50 text-xs">
                                  <Plus className="w-3 h-3 mr-1" /> Manual
                                </Badge>
                              ) : (
                                <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-700/50 text-xs">
                                  <FileText className="w-3 h-3 mr-1" /> CSV
                                </Badge>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <Badge className={
                                v.status === "active"
                                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-600 text-xs"
                                  : "bg-slate-500/20 text-slate-400 border border-slate-600 text-xs"
                              }>
                                {v.status === "active" ? "Aktif" : String(v.status ?? "aktif")}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-xs min-w-[190px]">
                              <Badge className={
                                evidence.tone === "ok"
                                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-700/50 text-xs"
                                  : evidence.tone === "warning"
                                    ? "bg-amber-500/15 text-amber-300 border border-amber-700/50 text-xs"
                                    : "bg-slate-500/15 text-slate-300 border border-slate-600 text-xs"
                              }>{evidence.label}</Badge>
                              {evidence.reasons.length > 0 && (
                                <div className="mt-1 text-slate-400 whitespace-normal" title={evidence.reasons.join("; ")}>
                                  {evidence.reasons.join(" · ")}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

      </div>

      {/* Owner/Super Admin: edit only annual tax metadata of registered Diva units. */}
      <Dialog open={!!editTax} onOpenChange={(value) => { if (!value && !updateTax.isPending) setEditTax(null); }}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-md">
          <DialogHeader><DialogTitle>Edit Pajak Tahunan — {editTax?.plate}</DialogTitle></DialogHeader>
          {editTax && <div className="space-y-3">
            <p className="text-xs text-slate-400">Khusus aset PT Diva Servis. Perubahan disimpan dengan riwayat audit, tidak membuat pembayaran bank atau jurnal.</p>
            <div className="space-y-1">
              <Label>Status pajak</Label>
              <Select value={editTax.status} onValueChange={(status) =>
                setEditTax((p) => p ? ({
                  ...p,status,
                  paidOn: ["due_soon","unpaid"].includes(status) ? "" : p.paidOn,
                  dueOn: status === "paid_late_due_unverified" ? "" : p.dueOn,
                }) : p)}>
                <SelectTrigger className="bg-slate-700 border-slate-600 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid_due_verified">Sudah dibayar, jatuh tempo baru terverifikasi</SelectItem>
                  <SelectItem value="paid_late_due_unverified">Sudah dibayar, tanggal baru belum diketahui</SelectItem>
                  <SelectItem value="due_soon">Belum dibayar, mendekati jatuh tempo</SelectItem>
                  <SelectItem value="unpaid">Belum dibayar</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Tanggal pembayaran / perpanjangan</Label>
              <Input type="date" className="bg-slate-700 border-slate-600 text-white"
                value={editTax.paidOn} onChange={(e)=>setEditTax(p=>p?{...p,paidOn:e.target.value}:p)} />
            </div>
            <div className="space-y-1">
              <Label>Tanggal pajak berikutnya habis</Label>
              <Input type="date" className="bg-slate-700 border-slate-600 text-white"
                value={editTax.dueOn} onChange={(e)=>setEditTax(p=>p?{...p,dueOn:e.target.value}:p)}
                disabled={editTax.status==="paid_late_due_unverified"} />
              <p className="text-xs text-slate-400">Kosongkan jika tanggal masa berlaku baru belum terverifikasi.</p>
            </div>
            <div className="space-y-1">
              <Label>Alasan / catatan perubahan (opsional)</Label>
              <Input className="bg-slate-700 border-slate-600 text-white" maxLength={300}
                value={editTax.note} onChange={e=>setEditTax(p=>p?{...p,note:e.target.value}:p)} />
            </div>
            <Button className="w-full bg-blue-600 hover:bg-blue-700"
              disabled={updateTax.isPending || !editTax.version}
              onClick={()=>updateTax.mutate(editTax)}>
              {updateTax.isPending ? "Menyimpan..." : "Simpan Perubahan Pajak"}
            </Button>
          </div>}
        </DialogContent>
      </Dialog>

      {/* Dialog Tambah */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>Tambah Kendaraan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {([
              { label: "Nomor Plat *", key: "plate" as const },
              { label: "Merk", key: "brand" as const },
              { label: "Model", key: "model" as const },
              { label: "Tahun", key: "year" as const },
              { label: "Warna", key: "color" as const },
              { label: "Catatan", key: "notes" as const },
            ] as const).map(({ label, key }) => (
              <div key={key} className="space-y-1.5">
                <Label className="text-slate-300 text-sm">{label}</Label>
                <Input
                  value={form[key]}
                  onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                  className="bg-slate-700 border-slate-600 text-white"
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label className="text-slate-300 text-sm">Tipe Kendaraan</Label>
              <Select value={form.vehicleType} onValueChange={(v) => setForm((p) => ({ ...p, vehicleType: v }))}>
                <SelectTrigger className="bg-slate-700 border-slate-600 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="motor">Motor</SelectItem>
                  <SelectItem value="car">Mobil</SelectItem>
                  <SelectItem value="van">Van</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full bg-blue-600 hover:bg-blue-700"
              disabled={!form.plate || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "Menyimpan..." : "Simpan Kendaraan"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
