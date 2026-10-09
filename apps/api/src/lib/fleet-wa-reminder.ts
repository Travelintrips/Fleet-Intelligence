import { pool } from "./db";
import { getFleetWaGatewayStatus, normalizeFleetPhone, sendFleetWa } from "./wa-gateway-client";

type ReminderRow = {
  id: number;
  driver_name: string;
  driver_phone: string | null;
  vehicle_plate: string | null;
  outstanding_amount: string | number;
};

export type FleetReminderSweepResult = {
  companyId: number;
  eligible: number;
  sent: number;
  failed: number;
  skippedSuppressed: number;
  skippedNoPhone: number;
  lastError?: string | null;
  senderDevice?: string | null;
  deviceStatus?: string | null;
};

function formatIdr(value: unknown): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

async function ensureFleetReminderTables() {
  const result = await pool.query<{
    fleet_settings: string | null;
    fleet_wa_worker_state: string | null;
  }>(`
    select
      to_regclass('public.fleet_settings')::text as fleet_settings,
      to_regclass('public.fleet_wa_worker_state')::text as fleet_wa_worker_state
  `);

  const row = result.rows[0];
  const missing = [
    !row?.fleet_settings ? "fleet_settings" : null,
    !row?.fleet_wa_worker_state ? "fleet_wa_worker_state" : null,
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`Fleet reminder schema belum siap: ${missing.join(", ")}`);
  }
}

async function updateWorkerState(companyId: number, patch: {
  tick?: boolean;
  attempt?: boolean;
  success?: boolean;
  senderDevice?: string | null;
  deviceStatus?: string | null;
  result?: unknown;
  error?: string | null;
}) {
  await pool.query(
    `INSERT INTO public.fleet_wa_worker_state
      (company_id,last_tick_at,last_attempt_at,last_success_at,sender_device,device_status,last_result,last_error,updated_at)
     VALUES(
       $1,
       CASE WHEN $2 THEN NOW() ELSE NULL END,
       CASE WHEN $3 THEN NOW() ELSE NULL END,
       CASE WHEN $4 THEN NOW() ELSE NULL END,
       $5,$6,$7::jsonb,$8,NOW()
     )
     ON CONFLICT(company_id) DO UPDATE SET
       last_tick_at=CASE WHEN $2 THEN NOW() ELSE fleet_wa_worker_state.last_tick_at END,
       last_attempt_at=CASE WHEN $3 THEN NOW() ELSE fleet_wa_worker_state.last_attempt_at END,
       last_success_at=CASE WHEN $4 THEN NOW() ELSE fleet_wa_worker_state.last_success_at END,
       sender_device=COALESCE($5,fleet_wa_worker_state.sender_device),
       device_status=COALESCE($6,fleet_wa_worker_state.device_status),
       last_result=COALESCE($7::jsonb,fleet_wa_worker_state.last_result),
       last_error=CASE WHEN $9 THEN $8 ELSE fleet_wa_worker_state.last_error END,
       updated_at=NOW()`,
    [
      companyId,
      Boolean(patch.tick),
      Boolean(patch.attempt),
      Boolean(patch.success),
      patch.senderDevice ?? null,
      patch.deviceStatus ?? null,
      patch.result == null ? null : JSON.stringify(patch.result),
      patch.error ?? null,
      patch.error !== undefined,
    ],
  ).catch(() => undefined);
}

function reminderMessage(row: ReminderRow): string {
  const plate = String(row.vehicle_plate ?? "").trim();
  return [
    `Yth. Bapak/Ibu ${row.driver_name},`,
    "",
    "Pengingat outstanding driver GoCar - PT Diva Servis.",
    plate ? `Kendaraan: ${plate}` : null,
    `Outstanding saat ini: ${formatIdr(row.outstanding_amount)}`,
    "",
    "Mohon melakukan penyelesaian outstanding sesuai ketentuan yang berlaku.",
    "Jika pembayaran sudah dilakukan, abaikan pesan ini dan simpan bukti pembayaran untuk verifikasi.",
    "",
    "Terima kasih.",
    "PT Diva Servis",
  ].filter(Boolean).join("\n");
}

export async function sendFleetOutstandingReminders(args: {
  companyId: number;
  actor?: string;
  suppressHours?: number;
  ids?: number[];
  sendType?: "manual" | "selected" | "auto";
  minOutstanding?: number;
  phoneOverride?: string;
  messageOverride?: string;
}): Promise<FleetReminderSweepResult> {
  const companyId = args.companyId;
  const suppressHours = Math.max(1, Math.min(168, Number(args.suppressHours) || 24));
  const sendType = args.sendType ?? "manual";
  const ids = Array.isArray(args.ids) ? args.ids.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  const minOutstanding = Math.max(0, Number(args.minOutstanding) || 0);

  const params: unknown[] = [companyId, suppressHours, minOutstanding];
  let idFilter = "";
  if (ids.length) {
    params.push(ids);
    idFilter = ` AND o.id = ANY($${params.length}::int[])`;
  }

  const result = await pool.query<ReminderRow & { suppressed: boolean }>(
    `SELECT o.id,o.driver_name,
            COALESCE(NULLIF(d.phone,''),NULLIF(o.driver_phone,'')) AS driver_phone,
            COALESCE(NULLIF(d.vehicle_plate,''),NULLIF(o.vehicle_plate,'')) AS vehicle_plate,
            o.outstanding_amount,
            EXISTS (
              SELECT 1
                FROM public.fleet_wa_logs l
               WHERE l.company_id=o.company_id
                 AND l.outstanding_id=o.id
                 AND l.status='sent'
                 AND (l.sent_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
            ) AS suppressed
       FROM public.fleet_outstanding o
       JOIN public.fleet_drivers d
         ON d.id=o.driver_id
        AND d.company_id=o.company_id::text
      WHERE o.company_id=$1
        AND o.status='open'
        AND o.outstanding_amount >= $3
        AND d.status='active'
        AND COALESCE(d.source_present_in_latest_snapshot,true)=true
        ${idFilter}
      ORDER BY o.outstanding_amount DESC,o.id`,
    params,
  );

  let sent = 0;
  let failed = 0;
  let skippedSuppressed = 0;
  let skippedNoPhone = 0;
  let lastError: string | null = null;
  let senderDevice: string | null = process.env.FLEET_WA_DEVICE_ID?.trim() || null;
  let deviceStatus: string | null = null;
  const allowOverrides = ids.length === 1;

  for (const row of result.rows) {
    if (row.suppressed) {
      skippedSuppressed += 1;
      continue;
    }
    const phone = normalizeFleetPhone(allowOverrides ? (args.phoneOverride ?? row.driver_phone) : row.driver_phone);
    if (!phone) {
      skippedNoPhone += 1;
      continue;
    }
    const message = allowOverrides && args.messageOverride?.trim()
      ? args.messageOverride.trim()
      : reminderMessage(row);
    try {
      const provider = await sendFleetWa({
        phone,
        message,
        idempotencyKey: `fleet-wa:${companyId}:${row.id}:${sendType}`,
      });
      senderDevice = provider.senderDevice ?? senderDevice;
      deviceStatus = provider.deviceStatus ?? deviceStatus;
      await pool.query(
        `INSERT INTO public.fleet_wa_logs
          (company_id,outstanding_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,message,sent_by,send_type,status,sender_device,provider_message_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',$10,$11)`,
        [companyId,row.id,row.driver_name,phone,row.vehicle_plate,row.outstanding_amount,message,args.actor ?? "system",sendType,senderDevice,provider.messageId],
      );
      await pool.query(
        `UPDATE public.fleet_outstanding
            SET last_wa_sent_at=NOW(),is_notified=true,updated_at=NOW()
          WHERE id=$1 AND company_id=$2`,
        [row.id,companyId],
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      lastError = error instanceof Error ? error.message : String(error);
      await pool.query(
        `INSERT INTO public.fleet_wa_logs
          (company_id,outstanding_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,message,sent_by,send_type,status,sender_device,error_detail)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed',$10,$11)`,
        [companyId,row.id,row.driver_name,phone,row.vehicle_plate,row.outstanding_amount,message,args.actor ?? "system",sendType,senderDevice,lastError],
      ).catch(() => undefined);
    }
  }

  return {
    companyId,
    eligible: result.rows.length,
    sent,
    failed,
    skippedSuppressed,
    skippedNoPhone,
    lastError,
    senderDevice,
    deviceStatus,
  };
}

export async function runFleetAutoReminderSweep(): Promise<FleetReminderSweepResult[]> {
  await ensureFleetReminderTables();
  const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const hourWib = nowWib.getUTCHours();
  const dateWib = nowWib.toISOString().slice(0,10);

  const settings = await pool.query<{
    company_id: number;
    auto_blast_hour: number | null;
    auto_blast_last_run: string | Date | null;
    last_attempt_at: string | Date | null;
  }>(
    `SELECT s.company_id,s.auto_blast_hour,s.auto_blast_last_run,w.last_attempt_at
       FROM public.fleet_settings s
       LEFT JOIN public.fleet_wa_worker_state w ON w.company_id=s.company_id
      WHERE s.auto_blast_enabled=true`,
  );

  for (const row of settings.rows) {
    await updateWorkerState(Number(row.company_id), { tick: true });
  }

  const output: FleetReminderSweepResult[] = [];
  for (const row of settings.rows) {
    const companyId = Number(row.company_id);
    const configuredHour = Number(row.auto_blast_hour ?? 8);
    const lastRunDate = row.auto_blast_last_run
      ? new Date(row.auto_blast_last_run).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })
      : null;

    if (hourWib < configuredHour || lastRunDate === dateWib) continue;

    const lastAttemptMs = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : 0;
    const retryBackoffMs = 30 * 60 * 1000;
    if (lastAttemptMs && Date.now() - lastAttemptMs < retryBackoffMs) continue;

    // Fresh Gojek export is mandatory for scheduled WA reminders.
    const freshSync = await pool.query<{ id: string }>(
      `SELECT id FROM public.fleet_gojek_sync_jobs
        WHERE company_id=$1 AND status='succeeded'
          AND (finished_at AT TIME ZONE 'Asia/Jakarta')::date =
              (NOW() AT TIME ZONE 'Asia/Jakarta')::date
        ORDER BY finished_at DESC LIMIT 1`,
      [companyId],
    );
    if (!freshSync.rowCount) {
      await updateWorkerState(companyId, {
        error: 'Reminder ditunda: sinkronisasi Gojek hari ini belum berhasil. Tidak mengirim dengan data lama.',
      });
      continue;
    }
    const wa = await getFleetWaGatewayStatus().catch(() => null);
    const waReady = Boolean(
      wa?.configured &&
      wa?.gatewayHealthy &&
      wa?.deviceId &&
      wa?.deviceStatus === "ONLINE"
    );
    if (!waReady) {
      await updateWorkerState(companyId, {
        attempt: true,
        senderDevice: wa?.deviceId ?? null,
        deviceStatus: wa?.deviceStatus ?? null,
        error: `WA Fleet belum siap (gateway=${wa?.gatewayStatus ?? "UNREACHABLE"}, device=${wa?.deviceId ?? "belum diset"}, status=${wa?.deviceStatus ?? "UNKNOWN"}).`,
      });
      continue;
    }

    await updateWorkerState(companyId, {
      attempt: true,
      senderDevice: wa?.deviceId ?? null,
      deviceStatus: wa?.deviceStatus ?? null,
      error: null,
    });

    const claimed = await pool.query(
      `UPDATE public.fleet_settings
          SET auto_blast_last_run=NOW(),updated_at=NOW()
        WHERE company_id=$1
          AND auto_blast_enabled=true
          AND (
            auto_blast_last_run IS NULL
            OR (auto_blast_last_run AT TIME ZONE 'Asia/Jakarta')::date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date
          )
        RETURNING company_id`,
      [companyId],
    );
    if (!claimed.rowCount) continue;

    try {
      const result = await sendFleetOutstandingReminders({
        companyId,
        actor: "fleet-auto-reminder",
        suppressHours: 20,
        sendType: "auto",
        minOutstanding: 50_000,
      });
      await updateWorkerState(companyId, {
        success: result.failed === 0,
        senderDevice: result.senderDevice ?? null,
        deviceStatus: result.deviceStatus ?? null,
        result,
        error: result.failed > 0 ? `${result.failed} pesan gagal dikirim: ${result.lastError ?? "provider error"}` : null,
      });

      if (result.failed > 0) {
        await pool.query(
          `UPDATE public.fleet_settings
              SET auto_blast_last_run=NULL,updated_at=NOW()
            WHERE company_id=$1`,
          [companyId],
        ).catch(() => undefined);
      }

      output.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateWorkerState(companyId, { error: message });
      await pool.query(
        `UPDATE public.fleet_settings
            SET auto_blast_last_run=NULL,updated_at=NOW()
          WHERE company_id=$1`,
        [companyId],
      ).catch(() => undefined);
    }
  }
  return output;
}
