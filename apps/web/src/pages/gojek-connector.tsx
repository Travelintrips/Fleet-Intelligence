import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Link2, ShieldCheck, Database, FileDown, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type ConnectorStatus = {
  enabled: boolean;
  mode: string;
  portalUrl: string;
  allowedHost: string;
  ready: boolean;
  sharedSecretConfigured: boolean;
  encryptionKeyConfigured: boolean;
  maxFileMb: number;
  retentionHours: number;
  credentialStorage: string;
  loginCredentialConfigured?: boolean;
  fileRetention: string;
  handoffEndpoint: string;
  automationPolicy: string;
};

const LOCAL_BRIDGE = "http://127.0.0.1:17891";

export default function GojekConnectorPage() {
  const [bridgeStatus, setBridgeStatus] = useState<"checking"|"online"|"offline">("checking");
  const { data, isLoading, refetch, isFetching } = useQuery<ConnectorStatus>({
    queryKey: ["fleet-gojek-connector-status"],
    queryFn: async () => {
      const res = await fetch("/api/logistics/fleet/gojek-connector/status", { credentials: "include" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Gagal mengambil status connector");
      return json;
    },
    staleTime: 30_000,
  });

  async function checkBridge(showToast = false) {
    setBridgeStatus("checking");
    try {
      const res = await fetch(`${LOCAL_BRIDGE}/health`, { method: "GET", cache: "no-store" });
      if (!res.ok) throw new Error("Bridge tidak merespons");
      setBridgeStatus("online");
      if (showToast) toast.success("watcher lokal terhubung.");
      return true;
    } catch {
      setBridgeStatus("offline");
      if (showToast) toast.error("watcher lokal belum berjalan di PC ini.");
      return false;
    }
  }

  async function openPortal() {
    const online = bridgeStatus === "online" || await checkBridge();
    if (!online) {
      toast.error("Jalankan CST Fleet Windows Watcher terlebih dahulu.");
      return;
    }
    try {
      const res = await fetch(`${LOCAL_BRIDGE}/open`, { method: "POST" });
      if (!res.ok) throw new Error("Bridge gagal membuka portal");
      toast.success("Fleet Partner dibuka melalui Chrome biasa + watcher.");
    } catch (error) {
      setBridgeStatus("offline");
      toast.error(error instanceof Error ? error.message : "Bridge tidak dapat dihubungi.");
    }
  }

  useEffect(() => {
    void checkBridge();
    const timer = window.setInterval(() => void checkBridge(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Gojek Fleet Partner Connector</h1>
            <p className="mt-1 text-sm text-slate-400">Jalur export resmi Gojek → server handoff → Fleet transaction pipeline</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="gap-2" disabled={isFetching} onClick={() => { refetch(); void checkBridge(true); }}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <Button className="gap-2" disabled={!data?.portalUrl || bridgeStatus === "checking"} onClick={() => void openPortal()}>
              <ExternalLink className="h-4 w-4" /> Buka Fleet Partner Gojek
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          {[
            ["Connector", data?.enabled ? "Aktif" : "Nonaktif", data?.enabled ? "text-emerald-300" : "text-slate-400"],
            ["Receiver", data?.ready ? "Siap" : "Belum Siap", data?.ready ? "text-emerald-300" : "text-amber-300"],
            ["Credential Gojek", data?.loginCredentialConfigured ? "Hostinger Secret" : "Belum Diset", data?.loginCredentialConfigured ? "text-emerald-300" : "text-amber-300"],
            ["File Export", data?.fileRetention === "none" ? "Tidak Disimpan" : "Temporary", "text-emerald-300"],
            ["Watcher Lokal", bridgeStatus === "online" ? "Terhubung" : bridgeStatus === "checking" ? "Memeriksa…" : "Tidak Aktif", bridgeStatus === "online" ? "text-emerald-300" : "text-amber-300"],
          ].map(([label,value,cls]) => (
            <Card key={label} className="border-white/[0.07] bg-slate-900/70">
              <CardContent className="p-4">
                <div className="text-xs text-slate-500">{label}</div>
                <div className={`mt-1 text-base font-semibold ${cls}`}>{isLoading ? "Memuat…" : value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="border-white/[0.07] bg-slate-900/70">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4 text-indigo-300" /> Alur Connector</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-300">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 leading-7">
                <strong>1.</strong> Login Fleet Partner Gojek secara normal.<br/>
                <strong>2.</strong> Gunakan export/download resmi dari portal.<br/>
                <strong>3.</strong> Connector mengirim hasil export langsung ke receiver CST Fleet.<br/>
                <strong>4.</strong> Fleet memproses raw transaction → normalized transaction → dashboard/analytics.<br/>
                <strong>5.</strong> File export tidak disimpan permanen oleh Fleet.
              </div>
              <p className="text-xs text-slate-500">Tidak ada penyimpanan username/password Gojek, bypass OTP/CAPTCHA, stealth browsing, atau scraping private endpoint.</p>
            </CardContent>
          </Card>

          <Card className="border-white/[0.07] bg-slate-900/70">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Readiness</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] p-3 text-sm">
                <span className="text-slate-400">Shared secret</span>
                <span className={data?.sharedSecretConfigured ? "text-emerald-300" : "text-amber-300"}>{data?.sharedSecretConfigured ? "Configured" : "Belum diset"}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] p-3 text-sm">
                <span className="text-slate-400">Receiver endpoint</span>
                <span className="font-mono text-xs text-slate-300">{data?.handoffEndpoint ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] p-3 text-sm">
                <span className="text-slate-400">Batas export</span>
                <span className="text-slate-300">{data?.maxFileMb ?? "—"} MB</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] p-3 text-sm">
                <span className="text-slate-400">Allowed host</span>
                <span className="text-slate-300">{data?.allowedHost ?? "—"}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-indigo-400/15 bg-indigo-500/[0.05]">
          <CardContent className="flex gap-3 p-5">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-400/10"><FileDown className="h-4 w-4 text-indigo-300" /></div>
            <div>
              <div className="font-semibold text-slate-100">Export otomatis melalui Windows Watcher</div>
              <p className="mt-1 text-sm text-slate-400">Jalankan Windows Watcher sampai status “Watcher Lokal: Terhubung”. Setelah itu gunakan Chrome/Fleet Partner seperti biasa dan klik Export. CSV yang selesai masuk ke Downloads akan otomatis dikirim ke CST Fleet dan dihapus setelah import berhasil.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
