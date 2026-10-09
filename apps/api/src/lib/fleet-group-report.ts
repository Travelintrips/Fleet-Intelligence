import { pool } from "./db";
import { getFleetWaGatewayStatus } from "./wa-gateway-client";

function jakartaDate(value: Date): string {
  return new Date(value.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}
function groupId() {
  const value = String(process.env.ADMIN_WA_GROUP ?? "").trim();
  return /^\d{6,25}@g\.us$/.test(value) ? value : null;
}
async function sendReport(text: string, key: string) {
  const to = groupId();
  if (!to) return false;
  const status = await getFleetWaGatewayStatus();
  if (!status.gatewayHealthy || status.deviceStatus !== "ONLINE" || !status.deviceId) return false;
  const url = String(process.env.CST_WA_GATEWAY_URL ?? process.env.WA_GATEWAY_URL ?? "").replace(/\/$/, "");
  const token = String(process.env.CST_WA_GATEWAY_TOKEN ?? process.env.WA_GATEWAY_TOKEN ?? "");
  if (!url || !token) return false;
  const response = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ type: "text", to, text, deviceId: status.deviceId }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error("WA group report gateway HTTP " + response.status + ": " + responseText.slice(0, 160));
  }
  return true;
}

export async function runFleetGroupReportSweep() {
  if (process.env.NODE_ENV !== "production" || !groupId()) return;
  const today = jakartaDate(new Date());
  const client = await pool.connect();
  try {
    const jobs = await client.query<{id:string;finished_at:Date;result:unknown}>(`
      SELECT DISTINCT ON (company_id) id,finished_at,result
      FROM public.fleet_gojek_sync_jobs
      WHERE status='succeeded'
      AND (finished_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      ORDER BY company_id,finished_at DESC
    `);
    const reports: Array<{key:string;message:string}> = [];
    for (const j of jobs.rows) {
      const details = (j.result ?? {}) as Record<string,unknown>;
      reports.push({
        key: "gojek:" + j.id,
        message: "CST Fleet | Gojek Sync\nTanggal: " + today +
          "\nStatus: Berhasil\nSelesai: " + new Date(j.finished_at).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"}) +
          " WIB\nDriver tersinkronisasi: " + String(details.total ?? details.updated ?? "-") +
          "\nOutstanding diperbarui: " + String(details.outstandingUpserted ?? "-")
      });
    }
    const reminders = await client.query<{company_id:number;last_attempt_at:Date;last_result:unknown}>(`
      SELECT company_id,last_attempt_at,last_result FROM public.fleet_wa_worker_state
      WHERE last_attempt_at IS NOT NULL AND last_result IS NOT NULL
      AND (last_attempt_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
    `);
    for (const w of reminders.rows) {
      const data = w.last_result as Record<string, unknown>;
      const sent = await client.query<{count:string}>(`
        SELECT COUNT(DISTINCT outstanding_id)::text AS count
        FROM public.fleet_wa_logs
        WHERE company_id=$1 AND status='sent'
        AND (sent_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      `,[w.company_id]);
      reports.push({
        key: "reminder:" + w.company_id + ":" + today + ":" + new Date(w.last_attempt_at).toISOString(),
        message: "CST Fleet | Laporan WA Driver\nTanggal: " + today +
          "\nTotal calon penerima: " + String(data.eligible ?? "-") +
          "\nTerkirim tercatat hari ini: " + String(sent.rows[0]?.count ?? "0") +
          "\nGagal pada proses terakhir: " + String(data.failed ?? "-") +
          "\nDilewati (duplikat): " + String(data.skippedSuppressed ?? "-") +
          "\nCatatan: status sent adalah penerimaan oleh WA Gateway, bukan bukti dibaca."
      });
    }
    for (const report of reports) {
      const claim = await client.query<{report_key:string}>(`
        INSERT INTO public.fleet_group_report_log(report_key,status)
        VALUES($1,'sending')
        ON CONFLICT (report_key) DO UPDATE SET status='sending',error=NULL,updated_at=NOW()
        WHERE fleet_group_report_log.status='failed'
          AND fleet_group_report_log.updated_at < NOW()-INTERVAL '15 minutes'
        RETURNING report_key
      `,[report.key]);
      if (!claim.rowCount) continue;
      try {
        const accepted = await sendReport(report.message, "fleet-group:" + report.key);
        if (!accepted) {
          await client.query("DELETE FROM public.fleet_group_report_log WHERE report_key=$1",[report.key]);
          continue;
        }
        await client.query("UPDATE public.fleet_group_report_log SET status='accepted',updated_at=NOW() WHERE report_key=$1",[report.key]);
      } catch (error) {
        await client.query("UPDATE public.fleet_group_report_log SET status='failed',error=$2,updated_at=NOW() WHERE report_key=$1",
          [report.key,String(error).slice(0,500)]);
      }
    }
  } finally {
    client.release();
  }
}
