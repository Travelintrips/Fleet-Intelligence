import { pool } from "./db";

type AlertSweepResult = {
  companyId: number;
  outstandingCreatedOrUpdated: number;
  inactiveCreatedOrUpdated: number;
  revenueCreatedOrUpdated: number;
  resolved: number;
};

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${name}`],
  );
  return result.rows[0]?.exists === true;
}

function formatIdr(value: unknown): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

export async function syncFleetAlertsForCompany(companyId: number): Promise<AlertSweepResult> {
  if (!(await tableExists("fleet_alerts"))) {
    return {
      companyId,
      outstandingCreatedOrUpdated: 0,
      inactiveCreatedOrUpdated: 0,
      revenueCreatedOrUpdated: 0,
      resolved: 0,
    };
  }

  let resolved = 0;

  const outstanding = await pool.query(
    `INSERT INTO public.fleet_alerts
      (company_id, alert_type, severity, title, message, reference_type, reference_id, driver_id, is_read, is_notified, created_at)
     SELECT
       o.company_id,
       'outstanding_high',
       CASE WHEN o.outstanding_amount >= 1000000 THEN 'critical' ELSE 'warning' END,
       'Outstanding Tinggi — ' || o.driver_name,
       'Outstanding driver ' || o.driver_name || ' sebesar ' || $2 ||
         CASE WHEN NULLIF(o.vehicle_plate,'') IS NOT NULL THEN ' · ' || o.vehicle_plate ELSE '' END,
       'fleet_outstanding',
       o.id::text,
       o.driver_id,
       false,
       false,
       now()
     FROM public.fleet_outstanding o
     WHERE o.company_id=$1
       AND o.status='open'
       AND o.outstanding_amount >= 500000
     ON CONFLICT (company_id, alert_type, reference_type, reference_id)
       WHERE auto_resolved_at IS NULL
         AND reference_type IS NOT NULL
         AND reference_id IS NOT NULL
     DO UPDATE SET
       severity=EXCLUDED.severity,
       title=EXCLUDED.title,
       message=EXCLUDED.message,
       driver_id=EXCLUDED.driver_id
     RETURNING id`,
    [companyId, "__AMOUNT_PLACEHOLDER__"],
  ).catch(async () => {
    // Re-run with per-row formatted amount when legacy schema/index behavior rejects the optimized statement.
    const rows = await pool.query<{
      id: number;
      driver_name: string;
      vehicle_plate: string | null;
      outstanding_amount: string | number;
      driver_id: number | null;
    }>(
      `SELECT id,driver_name,vehicle_plate,outstanding_amount,driver_id
         FROM public.fleet_outstanding
        WHERE company_id=$1 AND status='open' AND outstanding_amount >= 500000`,
      [companyId],
    );
    let count = 0;
    for (const row of rows.rows) {
      const severity = Number(row.outstanding_amount) >= 1_000_000 ? "critical" : "warning";
      const title = `Outstanding Tinggi — ${row.driver_name}`;
      const message =
        `Outstanding driver ${row.driver_name} sebesar ${formatIdr(row.outstanding_amount)}` +
        (row.vehicle_plate ? ` · ${row.vehicle_plate}` : "");
      const result = await pool.query(
        `INSERT INTO public.fleet_alerts
          (company_id,alert_type,severity,title,message,reference_type,reference_id,driver_id,is_read,is_notified,created_at)
         VALUES($1,'outstanding_high',$2,$3,$4,'fleet_outstanding',$5,$6,false,false,now())
         ON CONFLICT (company_id, alert_type, reference_type, reference_id)
           WHERE auto_resolved_at IS NULL
             AND reference_type IS NOT NULL
             AND reference_id IS NOT NULL
         DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,message=EXCLUDED.message,driver_id=EXCLUDED.driver_id
         RETURNING id`,
        [companyId, severity, title, message, String(row.id), row.driver_id],
      );
      count += result.rowCount ?? 0;
    }
    return { rowCount: count } as { rowCount: number };
  });

  const resolvedOutstanding = await pool.query(
    `UPDATE public.fleet_alerts a
        SET auto_resolved_at=now()
      WHERE a.company_id=$1
        AND a.alert_type='outstanding_high'
        AND a.auto_resolved_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM public.fleet_outstanding o
           WHERE o.company_id=a.company_id
             AND o.id::text=a.reference_id
             AND o.status='open'
             AND o.outstanding_amount >= 500000
        )`,
    [companyId],
  );
  resolved += resolvedOutstanding.rowCount ?? 0;

  let inactiveCount = 0;
  if (await tableExists("fleet_drivers")) {
    const inactive = await pool.query(
      `INSERT INTO public.fleet_alerts
        (company_id, alert_type, severity, title, message, reference_type, reference_id, driver_id, is_read, is_notified, created_at)
       SELECT
         $1,
         'driver_inactive',
         'warning',
         'Driver Tidak Aktif — ' || d.full_name,
         'Driver ' || d.full_name || ' tidak memiliki aktivitas selama ' ||
           GREATEST(0,(CURRENT_DATE-d.last_active_date)::int)::text || ' hari.',
         'fleet_driver',
         d.id::text,
         d.id,
         false,
         false,
         now()
       FROM public.fleet_drivers d
       WHERE d.company_id=$1::text
         AND d.status='active'
         AND COALESCE(d.source_present_in_latest_snapshot,true)=true
         AND d.last_active_date IS NOT NULL
         AND d.last_active_date <= CURRENT_DATE - 7
       ON CONFLICT (company_id, alert_type, reference_type, reference_id)
         WHERE auto_resolved_at IS NULL
           AND reference_type IS NOT NULL
           AND reference_id IS NOT NULL
       DO UPDATE SET title=EXCLUDED.title,message=EXCLUDED.message,driver_id=EXCLUDED.driver_id
       RETURNING id`,
      [companyId],
    );
    inactiveCount = inactive.rowCount ?? 0;

    const resolvedInactive = await pool.query(
      `UPDATE public.fleet_alerts a
          SET auto_resolved_at=now()
        WHERE a.company_id=$1
          AND a.alert_type='driver_inactive'
          AND a.auto_resolved_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM public.fleet_drivers d
             WHERE d.company_id=$1::text
               AND d.id::text=a.reference_id
               AND d.status='active'
               AND COALESCE(d.source_present_in_latest_snapshot,true)=true
               AND d.last_active_date IS NOT NULL
               AND d.last_active_date <= CURRENT_DATE - 7
          )`,
      [companyId],
    );
    resolved += resolvedInactive.rowCount ?? 0;
  }

  let revenueCount = 0;
  if (await tableExists("fleet_daily_summary")) {
    const revenue = await pool.query<{
      last7: string | number;
      prev7: string | number;
    }>(
      `SELECT
         COALESCE(SUM(net_revenue) FILTER (
           WHERE summary_date >= CURRENT_DATE - 7 AND summary_date < CURRENT_DATE
         ),0)::numeric AS last7,
         COALESCE(SUM(net_revenue) FILTER (
           WHERE summary_date >= CURRENT_DATE - 14 AND summary_date < CURRENT_DATE - 7
         ),0)::numeric AS prev7
       FROM public.fleet_daily_summary
       WHERE company_id=$1`,
      [companyId],
    );
    const last7 = Number(revenue.rows[0]?.last7 ?? 0);
    const prev7 = Number(revenue.rows[0]?.prev7 ?? 0);
    const dropPct = prev7 > 0 ? ((prev7 - last7) / prev7) * 100 : 0;

    if (prev7 > 0 && dropPct > 15) {
      const severity = dropPct >= 30 ? "critical" : "warning";
      const title = `Revenue Turun ${dropPct.toFixed(1)}%`;
      const message = `Revenue 7 hari terakhir ${formatIdr(last7)}, turun ${dropPct.toFixed(1)}% dibanding 7 hari sebelumnya (${formatIdr(prev7)}).`;
      const result = await pool.query(
        `INSERT INTO public.fleet_alerts
          (company_id,alert_type,severity,title,message,reference_type,reference_id,is_read,is_notified,created_at)
         VALUES($1,'revenue_drop',$2,$3,$4,'fleet_metric','revenue_7d',false,false,now())
         ON CONFLICT (company_id, alert_type, reference_type, reference_id)
           WHERE auto_resolved_at IS NULL
             AND reference_type IS NOT NULL
             AND reference_id IS NOT NULL
         DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,message=EXCLUDED.message
         RETURNING id`,
        [companyId, severity, title, message],
      );
      revenueCount = result.rowCount ?? 0;
    } else {
      const recovered = await pool.query(
        `UPDATE public.fleet_alerts
            SET auto_resolved_at=now()
          WHERE company_id=$1
            AND alert_type='revenue_drop'
            AND reference_type='fleet_metric'
            AND reference_id='revenue_7d'
            AND auto_resolved_at IS NULL`,
        [companyId],
      );
      resolved += recovered.rowCount ?? 0;
    }
  }

  return {
    companyId,
    outstandingCreatedOrUpdated: outstanding.rowCount ?? 0,
    inactiveCreatedOrUpdated: inactiveCount,
    revenueCreatedOrUpdated: revenueCount,
    resolved,
  };
}

export async function runFleetAlertSweep(): Promise<AlertSweepResult[]> {
  if (!(await tableExists("fleet_alerts"))) return [];
  const companies = await pool.query<{ company_id: number }>(
    `SELECT DISTINCT company_id
       FROM (
         SELECT company_id::int AS company_id
           FROM public.fleet_outstanding
         UNION ALL
         SELECT company_id::int AS company_id
           FROM public.fleet_drivers
          WHERE company_id ~ '^[0-9]+$'
       ) x
      WHERE company_id > 0
      ORDER BY company_id`,
  );

  const results: AlertSweepResult[] = [];
  for (const row of companies.rows) {
    results.push(await syncFleetAlertsForCompany(Number(row.company_id)));
  }
  return results;
}
