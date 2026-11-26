import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

const emptyAssetForm = () => ({
  plate: "", vehicleType: "car", brand: "", model: "", year: "", color: "",
  chassisNumber: "", engineNumber: "", fuelType: "", notes: "",
  taxStatus: "unrecorded", taxPaidOn: "", taxDueOn: "",
});

export default function FleetVehiclesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editTax, setEditTax] = useState<null | {
    plate: string; paidOn: string; dueOn: string; status: string; version: string; note: string;
  }>(null);

  const [form, setForm] = useState(emptyAssetForm);

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
        assetCreateEnabled: boolean;
        assets: Array<{
          plate_number: string; brand: string; model: string; ownership_type: string; status: string;
          chassis_number: string | null; engine_number: string | null;
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
      const res = await fetch("/api/logistics/fleet/vehicles/diva-assets", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          year: form.year ? Number(form.year) : null,
          fuelType: form.fuelType || null,
          taxPaidOn: form.taxPaidOn || null,
          taxDueOn: form.taxDueOn || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(body.error || "Gagal menyimpan aset PT Diva Servis"));
      return body;
    },
    onSuccess: () => {
      toast.success("Kendaraan berhasil disimpan ke Aset PT Diva Servis");
      setOpen(false);
      setForm(emptyAssetForm());
      qc.invalidateQueries({ queryKey: ["fleet-diva-assets"] });
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
  const taxPaidRequired = ["paid_due_verified", "paid_late_due_unverified"].includes(form.taxStatus);
  const taxDueRequired = ["paid_due_verified", "due_soon", "unpaid"].includes(form.taxStatus);
  const taxDateOrderInvalid = !!(form.taxPaidOn && form.taxDueOn && form.taxDueOn <= form.taxPaidOn);
  const assetFormComplete = [form.plate, form.brand, form.model, form.chassisNumber, form.engineNumber]
    .every(value => value.trim().length > 0) &&
    (!taxPaidRequired || !!form.taxPaidOn) && (!taxDueRequired || !!form.taxDueOn) && !taxDateOrderInvalid;

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
          <div className="space-y-1.5 sm:text-right">
            <Button className="bg-blue-600 hover:bg-blue-700 gap-2"
              disabled={!divaAssets?.assetCreateEnabled || isDivaLoading || divaLoadError}
              aria-describedby={!divaAssets?.assetCreateEnabled ? "diva-create-availability" : undefined}
              onClick={() => { createMutation.reset(); setOpen(true); }}>
              <Plus className="w-4 h-4" /> Tambah Aset Diva
            </Button>
            {!divaAssets?.assetCreateEnabled && (
              <p id="diva-create-availability" className="text-xs text-slate-400 max-w-xs">
                {isDivaLoading ? "Memuat akses aset…" : divaLoadError
                  ? "Data aset gagal dimuat. Muat ulang untuk mencoba lagi."
                  : divaAssets ? "Penambahan aset belum tersedia."
                    : "Penambahan aset belum tersedia untuk akun ini."}
              </p>
            )}
          </div>
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

        {/* Access-scoped Diva registry. Read-only sessions never receive edit controls. */}
        {(isDivaLoading || divaAssets || divaLoadError) && (
          <Card className="bg-slate-900 border-slate-600 shadow-sm">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-white">Aset PT Diva Servis</h2>
                {divaAssets && <Badge className="shrink-0 border border-blue-500/30 bg-blue-500/10 text-blue-200">{divaAssets.assets.length} kendaraan</Badge>}
              </div>
              <p className="text-sm text-slate-200">
                Daftar kendaraan milik PT Diva Servis beserta identitas dan pajak tahunannya.
                Kendaraan baru dari tombol Tambah Aset Diva akan tampil di sini.
              </p>
              {isDivaLoading ? <p className="text-sm text-slate-400">Memuat aset...</p> : divaLoadError ? <p className="text-sm text-amber-300">Data aset belum dapat dibaca. Silakan periksa koneksi PROD.</p> : (
                <div className="overflow-x-auto rounded-md border border-slate-700">
                  <table className="w-full min-w-[1450px] table-auto text-sm">
                    <thead><tr className="bg-slate-800 text-left text-slate-100 uppercase tracking-wide">
                      <th className="px-3 py-3 pr-4 text-slate-100">Nomor polisi</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Merek / model</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Nomor rangka / VIN</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Nomor mesin</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Pemilik</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Status aset</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Pajak tahunan habis</th>
                      <th className="px-3 py-3 pr-4 text-slate-100">Perpanjangan pajak</th>
                      {divaAssets?.taxEditEnabled && <th className="px-3 py-3">Ubah pajak</th>}
                    </tr></thead>
                    <tbody>
                      {divaAssets?.assets.map(asset => (
                        <tr key={asset.plate_number} className="border-t border-slate-600 text-slate-100 odd:bg-slate-900 even:bg-slate-800/70">
                          <td className="px-3 py-3 pr-4 font-mono font-semibold text-white whitespace-nowrap">{asset.plate_number}</td>
                          <td className="px-3 py-3 pr-4 text-slate-100">{asset.brand} {asset.model}</td>
                          <td className="px-3 py-3 pr-4 text-slate-100 font-mono text-xs whitespace-nowrap">{asset.chassis_number || "Belum tercatat"}</td>
                          <td className="px-3 py-3 pr-4 text-slate-100 font-mono text-xs whitespace-nowrap">{asset.engine_number || "Belum tercatat"}</td>
                          <td className="px-3 py-3 pr-4 text-slate-100">PT Diva Servis</td>
                          <td className="px-3 py-3 pr-4 text-slate-100">{asset.ownership_type === "own" ? "Milik perusahaan" : "Perlu verifikasi"} · {asset.status === "registered" ? "Terdaftar" : asset.status}</td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {asset.tax_due_date ? fmtDate(asset.tax_due_date) : asset.tax_status === "unrecorded" ? "Belum tercatat" : "Jatuh tempo baru belum diverifikasi"}
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
                          {divaAssets?.taxEditEnabled && (
                            <td className="py-2 whitespace-nowrap">
                              {asset.tax_document_id && asset.tax_version ? (
                                <Button variant="outline" size="sm"
                                  onClick={() => setEditTax({
                                    plate:asset.plate_number,paidOn:asset.tax_renewed_on || "",
                                    dueOn:asset.tax_due_date || "",
                                    status:asset.tax_status || "due_soon",
                                    version:asset.tax_version || "",note:"",
                                  })}>
                                  <Pencil className="w-3 h-3 mr-1" /> Edit Pajak
                                </Button>
                              ) : <span className="text-xs text-slate-400">Data pajak belum lengkap</span>}
                            </td>
                          )}
                        </tr>
                      ))}
                      {divaAssets?.assets.length === 0 && (
                        <tr><td colSpan={divaAssets.taxEditEnabled ? 9 : 8} className="py-3 text-slate-400">Belum ada aset terdaftar</td></tr>
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

      {/* Authorized Fleet accounts: edit only annual tax metadata of Diva units. */}
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
                  paidOn: ["due_soon","unpaid","unrecorded"].includes(status) ? "" : p.paidOn,
                  dueOn: ["paid_late_due_unverified","unrecorded"].includes(status) ? "" : p.dueOn,
                }) : p)}>
                <SelectTrigger className="bg-slate-700 border-slate-600 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unrecorded">Belum tercatat</SelectItem>
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
                value={editTax.paidOn} onChange={(e)=>setEditTax(p=>p?{...p,paidOn:e.target.value}:p)}
                disabled={["due_soon","unpaid","unrecorded"].includes(editTax.status)} />
            </div>
            <div className="space-y-1">
              <Label>Tanggal pajak berikutnya habis</Label>
              <Input type="date" className="bg-slate-700 border-slate-600 text-white"
                value={editTax.dueOn} onChange={(e)=>setEditTax(p=>p?{...p,dueOn:e.target.value}:p)}
                disabled={["paid_late_due_unverified","unrecorded"].includes(editTax.status)} />
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

      {/* The registration form creates a Company-3 asset through its own endpoint. */}
      <Dialog open={open} onOpenChange={(value) => { if (!createMutation.isPending) setOpen(value); }}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white w-[calc(100vw-2rem)] max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Tambah Aset PT Diva Servis</DialogTitle>
            <DialogDescription className="text-slate-400">
              Lengkapi identitas kendaraan sesuai STNK. Kolom bertanda * wajib diisi.
            </DialogDescription>
          </DialogHeader>
          <form className="min-w-0 space-y-6" onSubmit={(event) => {
            event.preventDefault();
            if (assetFormComplete && divaAssets?.assetCreateEnabled && !createMutation.isPending) createMutation.mutate();
          }}>
            <fieldset disabled={createMutation.isPending} className="min-w-0 space-y-6 disabled:opacity-70">
              <dl className="grid gap-3 rounded-lg border border-blue-500/25 bg-blue-500/10 p-4 sm:grid-cols-3">
                <div><dt className="text-xs text-slate-400">Pemilik</dt><dd className="mt-1 text-sm font-medium">PT Diva Servis</dd></div>
                <div><dt className="text-xs text-slate-400">Kepemilikan</dt><dd className="mt-1 text-sm">Milik perusahaan</dd></div>
                <div><dt className="text-xs text-slate-400">Status aset</dt><dd className="mt-1 text-sm">Terdaftar</dd></div>
              </dl>

              <section aria-labelledby="diva-vehicle-heading" className="space-y-4">
                <h3 id="diva-vehicle-heading" className="text-sm font-semibold text-white">Identitas kendaraan</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="diva-plate" className="text-slate-300">Nomor polisi *</Label>
                    <Input id="diva-plate" required maxLength={20} placeholder="Contoh: B 1234 XYZ"
                      value={form.plate} onChange={(e) => setForm(p => ({ ...p, plate: e.target.value.toUpperCase() }))}
                      className="bg-slate-700 border-slate-600 text-white uppercase" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="diva-vehicle-type" className="text-slate-300">Tipe kendaraan</Label>
                    <Select value={form.vehicleType} onValueChange={(vehicleType) => setForm(p => ({ ...p, vehicleType }))}>
                      <SelectTrigger id="diva-vehicle-type" className="min-w-0 bg-slate-700 border-slate-600 text-white"><SelectValue /></SelectTrigger>
                      <SelectContent searchable={false} className="max-w-[calc(100vw-3rem)]">
                        <SelectItem value="car">Mobil</SelectItem>
                        <SelectItem value="motor">Motor</SelectItem>
                        <SelectItem value="van">Van</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {([
                    { label: "Merek *", key: "brand", maxLength: 100, placeholder: "Contoh: Wuling" },
                    { label: "Model *", key: "model", maxLength: 100, placeholder: "Contoh: Cloud EV" },
                    { label: "Nomor rangka / VIN *", key: "chassisNumber", maxLength: 64, placeholder: "Sesuai STNK" },
                    { label: "Nomor mesin *", key: "engineNumber", maxLength: 64, placeholder: "Sesuai STNK" },
                  ] as const).map(({ label, key, maxLength, placeholder }) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`diva-${key}`} className="text-slate-300">{label}</Label>
                      <Input id={`diva-${key}`} required maxLength={maxLength} placeholder={placeholder}
                        value={form[key]}
                        onChange={(e) => setForm(p => ({ ...p, [key]: key === "chassisNumber" || key === "engineNumber" ? e.target.value.toUpperCase() : e.target.value }))}
                        className="bg-slate-700 border-slate-600 text-white" />
                    </div>
                  ))}
                  <div className="space-y-1.5">
                    <Label htmlFor="diva-year" className="text-slate-300">Tahun pembuatan</Label>
                    <Input id="diva-year" type="number" min={1900} max={new Date().getFullYear() + 1} step={1}
                      value={form.year} onChange={(e) => setForm(p => ({ ...p, year: e.target.value }))}
                      className="bg-slate-700 border-slate-600 text-white" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="diva-color" className="text-slate-300">Warna</Label>
                    <Input id="diva-color" maxLength={60}
                      value={form.color} onChange={(e) => setForm(p => ({ ...p, color: e.target.value }))}
                      className="bg-slate-700 border-slate-600 text-white" />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="diva-fuel-type" className="text-slate-300">Bahan bakar / energi</Label>
                    <Select value={form.fuelType || "unspecified"} onValueChange={(value) => setForm(p => ({ ...p, fuelType: value === "unspecified" ? "" : value }))}>
                      <SelectTrigger id="diva-fuel-type" className="min-w-0 bg-slate-700 border-slate-600 text-white"><SelectValue /></SelectTrigger>
                      <SelectContent searchable={false} className="max-w-[calc(100vw-3rem)]">
                        <SelectItem value="unspecified">Belum diisi</SelectItem>
                        <SelectItem value="electric">Listrik</SelectItem>
                        <SelectItem value="bensin">Bensin</SelectItem>
                        <SelectItem value="solar">Diesel</SelectItem>
                        <SelectItem value="hybrid">Hybrid</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              <section aria-labelledby="diva-tax-heading" className="space-y-4 border-t border-slate-700 pt-5">
                <div>
                  <h3 id="diva-tax-heading" className="text-sm font-semibold text-white">Pajak tahunan</h3>
                  <p className="mt-1 text-xs text-slate-400">Pilih Belum tercatat jika data pajak belum tersedia.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="diva-tax-status" className="text-slate-300">Status pajak</Label>
                  <Select value={form.taxStatus} onValueChange={(taxStatus) => setForm(p => ({
                    ...p, taxStatus,
                    taxPaidOn: ["due_soon", "unpaid", "unrecorded"].includes(taxStatus) ? "" : p.taxPaidOn,
                    taxDueOn: ["paid_late_due_unverified", "unrecorded"].includes(taxStatus) ? "" : p.taxDueOn,
                  }))}>
                    <SelectTrigger id="diva-tax-status" className="min-w-0 bg-slate-700 border-slate-600 text-white"><SelectValue /></SelectTrigger>
                    <SelectContent searchable={false} className="max-w-[calc(100vw-3rem)]">
                      <SelectItem value="unrecorded">Belum tercatat</SelectItem>
                      <SelectItem value="unpaid">Belum dibayar</SelectItem>
                      <SelectItem value="due_soon">Belum dibayar, mendekati jatuh tempo</SelectItem>
                      <SelectItem value="paid_due_verified">Sudah dibayar, jatuh tempo baru terverifikasi</SelectItem>
                      <SelectItem value="paid_late_due_unverified">Sudah dibayar, tanggal baru belum diketahui</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="diva-tax-paid-on" className="text-slate-300">Tanggal pembayaran / perpanjangan{taxPaidRequired ? " *" : ""}</Label>
                    <Input id="diva-tax-paid-on" type="date" min="2000-01-01" max="2099-12-31" required={taxPaidRequired} disabled={!taxPaidRequired}
                      value={form.taxPaidOn} onChange={(e) => setForm(p => ({ ...p, taxPaidOn: e.target.value }))}
                      className="bg-slate-700 border-slate-600 text-white" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="diva-tax-due-on" className="text-slate-300">Tanggal pajak tahunan habis{taxDueRequired ? " *" : ""}</Label>
                    <Input id="diva-tax-due-on" type="date" min="2000-01-01" max="2099-12-31" required={taxDueRequired} disabled={!taxDueRequired}
                      aria-invalid={taxDateOrderInvalid || undefined}
                      aria-describedby={taxDateOrderInvalid ? "diva-tax-date-error" : undefined}
                      value={form.taxDueOn} onChange={(e) => setForm(p => ({ ...p, taxDueOn: e.target.value }))}
                      className="bg-slate-700 border-slate-600 text-white" />
                  </div>
                </div>
                {taxDateOrderInvalid && <p id="diva-tax-date-error" role="alert" className="text-sm text-rose-300">Tanggal pajak berikutnya harus sesudah tanggal pembayaran.</p>}
              </section>

              <div className="space-y-1.5">
                <Label htmlFor="diva-notes" className="text-slate-300">Catatan (opsional)</Label>
                <Input id="diva-notes" maxLength={1000} value={form.notes}
                  onChange={(e) => setForm(p => ({ ...p, notes: e.target.value }))}
                  className="bg-slate-700 border-slate-600 text-white" />
              </div>
            </fieldset>

            {createMutation.isError && <p role="alert" className="rounded-md border border-rose-800 bg-rose-950/30 p-3 text-sm text-rose-200">{createMutation.error.message}</p>}
            <div className="flex flex-col-reverse gap-2 border-t border-slate-700 pt-4 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" disabled={createMutation.isPending} onClick={() => setOpen(false)}>Batal</Button>
              <Button type="submit" className="bg-blue-600 hover:bg-blue-700"
                disabled={!assetFormComplete || !divaAssets?.assetCreateEnabled || createMutation.isPending}>
                {createMutation.isPending ? "Menyimpan…" : "Simpan ke Aset PT Diva Servis"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
