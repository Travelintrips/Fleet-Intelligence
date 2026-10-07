import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, CheckCircle2, Clock3, MessageCircle, RefreshCw, Send, Server, Smartphone, Wifi, WifiOff } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";

type Device = { deviceId:string; name:string|null; status:string; enabled:boolean; lastHeartbeatAt:string|null };
type WaStatus = { configured:boolean; gatewayHealthy:boolean; gatewayStatus:string; deviceId:string|null; deviceStatus:string|null; deviceSelection:string; visibleDevices:Device[] };

function fmtDate(value: unknown) {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("id-ID", { dateStyle:"medium", timeStyle:"short" });
}

function StateBadge({ ok, label }: { ok:boolean; label:string }) {
  return <span className={"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold " + (ok ? "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300" : "border-rose-400/20 bg-rose-400/[0.08] text-rose-300")}>
    <span className={"h-1.5 w-1.5 rounded-full " + (ok ? "bg-emerald-400" : "bg-rose-400")} />{label}
  </span>;
}

export default function FleetWhatsAppPage() {
  const [phone,setPhone]=useState("");
  const [message,setMessage]=useState("Tes koneksi WhatsApp dari CST Fleet Intelligence.");

  const statusQuery=useQuery({
    queryKey:["fleet-wa-center-status"],
    queryFn:async()=>{ const r=await fetch("/api/logistics/fleet/wa/status",{credentials:"include"}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error??"Gagal mengambil status WA"); return j as WaStatus; },
    refetchInterval:30000,
  });
  const workerQuery=useQuery({
    queryKey:["fleet-wa-center-worker"],
    queryFn:async()=>{ const r=await fetch("/api/logistics/fleet/outstanding/wa-worker-state",{credentials:"include"}); return r.ok ? r.json() as Promise<{worker:Record<string,unknown>|null}> : {worker:null}; },
    refetchInterval:30000,
  });
  const settingsQuery=useQuery({
    queryKey:["fleet-wa-center-settings"],
    queryFn:async()=>{ const r=await fetch("/api/logistics/fleet/outstanding/auto-blast-settings",{credentials:"include"}); return r.ok ? r.json() as Promise<{enabled:boolean;hour:number;last_run:string|null}> : {enabled:false,hour:8,last_run:null}; },
  });
  const logsQuery=useQuery({
    queryKey:["fleet-wa-center-logs"],
    queryFn:async()=>{ const r=await fetch("/api/logistics/fleet/outstanding/wa-logs?limit=20",{credentials:"include"}); return r.ok ? r.json() as Promise<{logs:Array<Record<string,unknown>>;total:number}> : {logs:[],total:0}; },
  });

  const testMutation=useMutation({
    mutationFn:async()=>{ const r=await fetch("/api/logistics/fleet/wa/test",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone,message})}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error??"Tes WhatsApp gagal"); return j; },
    onSuccess:()=>{ toast.success("Pesan test WhatsApp berhasil dikirim"); void logsQuery.refetch(); },
    onError:(e:Error)=>toast.error(e.message),
  });

  const status=statusQuery.data;
  const worker=workerQuery.data?.worker;
  const settings=settingsQuery.data;
  const logs=logsQuery.data?.logs??[];
  const ready=Boolean(status?.configured&&status?.gatewayHealthy&&status?.deviceId&&status?.deviceStatus==="ONLINE");
  const refreshAll=()=>Promise.all([statusQuery.refetch(),workerQuery.refetch(),settingsQuery.refetch(),logsQuery.refetch()]);

  return <AppShell><div className="space-y-6">
    <Link href="/logistics/fleet-intelligence"><Button variant="ghost" size="sm" className="gap-1.5 -ml-2 text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4"/>Fleet Intelligence</Button></Link>
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div><h1 className="text-2xl font-bold text-white">WhatsApp Integration</h1><p className="mt-1 text-sm text-slate-400">Status WA Gateway, device Fleet, worker reminder, auto-blast dan pengujian pengiriman.</p></div>
      <Button variant="outline" size="sm" className="gap-2" onClick={()=>void refreshAll()}><RefreshCw className="h-4 w-4"/>Refresh</Button>
    </div>

    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
      <Card><CardContent className="p-5"><Server className="mb-3 h-5 w-5 text-indigo-300"/><div className="text-xs text-slate-500">WA Gateway</div><div className="mt-1 text-lg font-semibold text-white">{status?.gatewayStatus??"—"}</div><div className="mt-3"><StateBadge ok={Boolean(status?.gatewayHealthy)} label={status?.gatewayHealthy?"Healthy":"Tidak Healthy"}/></div></CardContent></Card>
      <Card><CardContent className="p-5"><Smartphone className="mb-3 h-5 w-5 text-cyan-300"/><div className="text-xs text-slate-500">Device Fleet</div><div className="mt-1 truncate text-lg font-semibold text-white">{status?.deviceId??"Belum dipilih"}</div><div className="mt-3"><StateBadge ok={status?.deviceStatus==="ONLINE"} label={status?.deviceStatus??"UNKNOWN"}/></div></CardContent></Card>
      <Card><CardContent className="p-5">{ready?<Wifi className="mb-3 h-5 w-5 text-emerald-300"/>:<WifiOff className="mb-3 h-5 w-5 text-rose-300"/>}<div className="text-xs text-slate-500">Kesiapan Kirim</div><div className="mt-1 text-lg font-semibold text-white">{ready?"Siap":"Belum Siap"}</div><div className="mt-3"><StateBadge ok={ready} label={ready?"Connected":"Check Config"}/></div></CardContent></Card>
      <Card><CardContent className="p-5"><Clock3 className="mb-3 h-5 w-5 text-amber-300"/><div className="text-xs text-slate-500">Auto Blast</div><div className="mt-1 text-lg font-semibold text-white">{settings?.enabled?"Aktif":"Nonaktif"}</div><div className="mt-1 text-xs text-slate-500">{settings?.enabled ? "Setiap " + String(settings.hour??8).padStart(2,"0") + ":00 WIB" : "Tidak dijadwalkan"}</div></CardContent></Card>
    </div>

    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Smartphone className="h-4 w-4 text-indigo-300"/>Device yang Terlihat</CardTitle></CardHeader><CardContent className="space-y-3">
        {statusQuery.isLoading ? <div className="text-sm text-slate-500">Memeriksa device…</div> : (status?.visibleDevices?.length??0)===0 ? <div className="rounded-xl border border-dashed border-white/[0.08] p-6 text-center text-sm text-slate-500">Tidak ada device yang dapat dibaca oleh API Client Fleet.</div> : status!.visibleDevices.map((d)=><div key={d.deviceId} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4"><div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-100">{d.name||d.deviceId}</div><div className="mt-1 truncate text-xs text-slate-500">{d.deviceId}</div><div className="mt-1 text-xs text-slate-600">Heartbeat: {fmtDate(d.lastHeartbeatAt)}</div></div><StateBadge ok={d.enabled&&d.status==="ONLINE"} label={d.enabled?d.status:"DISABLED"}/></div>)}
      </CardContent></Card>

      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Send className="h-4 w-4 text-emerald-300"/>Test Kirim WhatsApp</CardTitle></CardHeader><CardContent className="space-y-3">
        <div><div className="mb-1.5 text-xs font-medium text-slate-400">Nomor tujuan</div><Input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="Contoh: 081234567890"/></div>
        <div><div className="mb-1.5 text-xs font-medium text-slate-400">Pesan</div><textarea value={message} onChange={e=>setMessage(e.target.value)} rows={5} className="w-full rounded-lg border border-white/[0.09] bg-slate-950/45 px-3 py-2 text-sm text-slate-100 outline-none"/></div>
        <Button className="w-full gap-2" disabled={!ready||!phone.trim()||!message.trim()||testMutation.isPending} onClick={()=>testMutation.mutate()}><MessageCircle className="h-4 w-4"/>{testMutation.isPending?"Mengirim…":"Kirim Pesan Test"}</Button>
        {!ready&&<p className="text-xs text-rose-300">Test dinonaktifkan sampai Gateway dan device Fleet berstatus ONLINE.</p>}
      </CardContent></Card>
    </div>

    <Card><CardHeader><CardTitle className="text-base">Worker & Riwayat Pengiriman</CardTitle></CardHeader><CardContent>
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"><div className="text-xs text-slate-500">Last tick</div><div className="mt-1 text-sm text-slate-200">{fmtDate(worker?.last_tick_at)}</div></div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"><div className="text-xs text-slate-500">Last attempt</div><div className="mt-1 text-sm text-slate-200">{fmtDate(worker?.last_attempt_at)}</div></div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"><div className="text-xs text-slate-500">Last success</div><div className="mt-1 text-sm text-slate-200">{fmtDate(worker?.last_success_at)}</div></div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"><div className="text-xs text-slate-500">Last error</div><div className="mt-1 text-sm text-slate-200">{String(worker?.last_error??"—")}</div></div>
      </div>
      {logs.length===0 ? <div className="rounded-xl border border-dashed border-white/[0.08] p-8 text-center text-sm text-slate-500">Belum ada log pengiriman WhatsApp Fleet.</div> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-white/[0.08]"><th className="px-3 py-3">Waktu</th><th className="px-3 py-3">Driver</th><th className="px-3 py-3">Nomor</th><th className="px-3 py-3">Tipe</th><th className="px-3 py-3">Status</th></tr></thead><tbody>{logs.map((row,i)=><tr key={String(row.id??i)} className="border-b border-white/[0.05]"><td className="px-3 py-3 text-slate-400">{fmtDate(row.sent_at)}</td><td className="px-3 py-3 text-slate-200">{String(row.driver_name??"—")}</td><td className="px-3 py-3 text-slate-400">{String(row.phone??row.driver_phone??"—")}</td><td className="px-3 py-3 text-slate-400">{String(row.send_type??"—")}</td><td className="px-3 py-3">{String(row.status??"").toLowerCase()==="sent"||row.success===true?<span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5"/>Sent</span>:<span className="text-slate-400">{String(row.status??row.error??"—")}</span>}</td></tr>)}</tbody></table></div>}
    </CardContent></Card>
  </div></AppShell>;
}
