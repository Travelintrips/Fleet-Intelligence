import { pool } from "./db";

/**
 * Enqueue once per Jakarta date after 01:00 WIB, for companies that opted into
 * automatic Fleet reminders. The database advisory lock prevents duplicate jobs
 * across multiple API instances/restarts.
 */
export async function runFleetGojekScheduledSyncSweep(): Promise<number[]> {
  if (process.env.APP_ENV === "development" || process.env.NODE_ENV !== "production") return [];
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta", hour: "2-digit", hourCycle: "h23"
  }).format(new Date()));
  if (hour < 1) return [];
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const actor = `fleet-scheduler-0100-wib:${day}`;
  const client = await pool.connect();
  const queued: number[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fleet_gojek_daily_sync'))");
    const companies = await client.query<{company_id:number}>(`
      SELECT company_id FROM public.fleet_settings
      WHERE auto_blast_enabled=true
    `);
    for (const row of companies.rows) {
      const companyId = Number(row.company_id);
      const result = await client.query<{id:string}>(`
        INSERT INTO public.fleet_gojek_sync_jobs(company_id,requested_by,status)
        SELECT $1,$2,'pending'
        WHERE NOT EXISTS(
          SELECT 1 FROM public.fleet_gojek_sync_jobs
          WHERE company_id=$1 AND requested_by=$2
        ) AND NOT EXISTS(
          SELECT 1 FROM public.fleet_gojek_sync_jobs
          WHERE company_id=$1 AND status IN ('pending','running')
        )
        RETURNING id
      `, [companyId, actor]);
      if (result.rowCount) queued.push(companyId);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return queued;
}
