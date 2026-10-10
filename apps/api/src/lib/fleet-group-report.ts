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
  const groupResponse = await fetch(url + "/v1/groups", {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(10000),
  });
  if (!groupResponse.ok) {
    throw new Error("WA Gateway groups lookup HTTP " + groupResponse.status + "; token must have groups:read");
  }
  const registry = await groupResponse.json() as { groups?: Array<{id?: string;jid?: string;isActive?: boolean;deviceId?: string}> };
  const group = (registry.groups ?? []).find(item => item.jid === to && item.isActive !== false);
  if (!group?.id) {
    throw new Error("Group " + to + " not found in WA Gateway assigned groups; sync groups and verify device membership");
  }
  const response = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ type: "text", groupId: group.id, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error("WA group report gateway HTTP " + response.status + ": " + responseText.slice(0, 160));
  }
  return true;
}

export async function runFleetGroupReportSweep() {
  if (process.env.NODE_ENV !== "production") return;
  if (!groupId()) {
    await pool.query(
      "INSERT INTO public.fleet_group_report_log(report_key,status,error) VALUES($1,$2,$3) ON CONFLICT (report_key) DO UPDATE SET error=EXCLUDED.error,status=EXCLUDED.status,updated_at=NOW()",
      ["config:" + jakartaDate(new Date()), "failed", "ADMIN_WA_GROUP belum tersedia atau bukan Group ID @g.us pada runtime CST Fleet."],
    );
    return;
  }
  const today = jakartaDate(new Date());
  const client = await pool.connect();
  try {
    const jobs = await client.query<{id:string;finished_at:Date;result:unknown}>(`
      SELECT DISTINCT ON (company_id) id,finished_at,result
      FROM public.fleet_gojek_sync_jobs
      WHERE status='succeeded'
      AND result->>'exportType'='driver_snapshot'
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
    // Driver reminder copies are delivered by WA Gateway device group routing.
    // Do not mirror them again here; otherwise each driver reminder appears twice.
    for (const report of reports) {
      const claim = await client.query<{report_key:string}>(`
        INSERT INTO public.fleet_group_report_log(report_key,status)
        VALUES($1,'sending')
        ON CONFLICT (report_key) DO UPDATE SET status='sending',error=NULL,updated_at=NOW()
        WHERE (fleet_group_report_log.status='failed'
           AND fleet_group_report_log.updated_at < NOW()-INTERVAL '15 minutes')
           OR (fleet_group_report_log.status='sending'
           AND fleet_group_report_log.updated_at < NOW()-INTERVAL '15 minutes')
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
