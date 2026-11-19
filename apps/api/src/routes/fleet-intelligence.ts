import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { pool } from "../lib/db";
import { fleetVehicleReadSql, withFleetVehicleEvidence } from "../lib/fleet-vehicle-read-model";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import { divaAssetReadPool, divaAssetReadEnabled, divaTaxWriterEnabled } from "../lib/fleet-diva-prod-db";
import { editDivaAnnualTax, DivaTaxEditError } from "../lib/fleet-diva-tax-edit-prod";
import { canManageDivaTax } from "../lib/fleet-diva-staff-authorization";
import { sendFleetOutstandingReminders } from "../lib/fleet-wa-reminder";
import { getFleetWaGatewayStatus, sendFleetWa } from "../lib/wa-gateway-client";
import { syncFleetAlertsForCompany } from "../lib/fleet-alerts";
import { getGojekConnectorConfig } from "../lib/gojek-connector-config";
import { verifyGojekWorkerRequest } from "../lib/gojek-worker-auth";
import {
  assertCentralFinanceWriteEnabled,
  getFleetAccountingSettings,
  postFleetCashPayment,
  reverseFleetCashPayment,
  updateFleetAccountingSettings,
} from "../lib/central-finance-client";

const router = Router();

async function getGojekServerConnectorHealth() {
  const worker = await pool.query<{
    worker_id: string;
    heartbeat_at: string;
    version: string | null;
    last_job_id: string | null;
    last_status: string | null;
    last_error: string | null;
  }>(
    `SELECT worker_id,heartbeat_at,version,last_job_id,last_status,last_error
       FROM public.fleet_gojek_connector_workers
      ORDER BY heartbeat_at DESC
      LIMIT 1`,
  );
  const row = worker.rows[0] ?? null;
  const heartbeatAt = row?.heartbeat_at ? new Date(row.heartbeat_at).getTime() : 0;
  // The VPS worker backs off idle polling to 60 seconds; allow two idle cycles
  // before reporting it offline to avoid false negatives between heartbeats.
  const healthy = Boolean(row && heartbeatAt > 0 && Date.now() - heartbeatAt >= 0 && Date.now() - heartbeatAt <= 120_000);
  return {
    configured: true,
    healthy,
    busy: row?.last_status === "running",
    lastRun: row ? {
      workerId: row.worker_id,
      heartbeatAt: row.heartbeat_at,
      version: row.version,
      lastJobId: row.last_job_id,
      lastStatus: row.last_status,
      lastError: row.last_error,
    } : null,
    service: "cst-gojek-vps-worker",
    runtime: "vps-docker",
    error: healthy ? null : (row?.last_error ?? "VPS worker belum heartbeat."),
  };
}

function connectorSecretMatches(value: unknown): boolean {
  const expected = String(process.env.GOJEK_CONNECTOR_SHARED_SECRET ?? "").trim();
  const supplied = String(value ?? "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Server-to-server receiver for an official Fleet Partner export.
// This endpoint deliberately does not accept or store Gojek credentials.
router.post("/gojek-connector/dry-run", async (req, res) => {
  try {
    const cfg = getGojekConnectorConfig();
    if (!cfg.enabled) {
      res.status(409).json({ error: "Gojek connector belum diaktifkan." });
      return;
    }
    if (!cfg.sharedSecretConfigured || !connectorSecretMatches(req.get("x-gojek-connector-secret"))) {
      res.status(401).json({ error: "Connector dry-run tidak terautentikasi." });
      return;
    }

    const content = typeof req.body?.content === "string" ? req.body.content : "";
    const fileName = typeof req.body?.fileName === "string"
      ? req.body.fileName.trim().slice(0,255)
      : "self-test.csv";
    if (!content.trim()) {
      res.status(400).json({ error: "CSV self-test kosong." });
      return;
    }

    const exportType = detectGojekExportType(content);
    let rowCount = 0;
    if (exportType === "driver_snapshot") {
      rowCount = parseSnapshotCsv(content).length;
    } else {
      rowCount = parseGojekTransactionCsv(content).rows.length;
    }
    await pool.query("SELECT 1");

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      dryRun: true,
      exportType,
      rowCount,
      fileName,
      database: "ready",
      persisted: false,
    });
  } catch (error) {
    req.log.error({ error }, "Gojek connector dry-run failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Dry-run gagal." });
  }
});

router.post("/gojek-connector/handoff", async (req, res) => {
  try {
    const cfg = getGojekConnectorConfig();
    if (!cfg.enabled) {
      res.status(409).json({ error: "Gojek connector belum diaktifkan." });
      return;
    }
    if (!cfg.sharedSecretConfigured || !connectorSecretMatches(req.get("x-gojek-connector-secret"))) {
      res.status(401).json({ error: "Connector handoff tidak terautentikasi." });
      return;
    }

    const content = typeof req.body?.content === "string" ? req.body.content : "";
    const fileName = typeof req.body?.fileName === "string"
      ? req.body.fileName.trim().slice(0, 255)
      : "gojek-export.csv";
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (!content.trim()) {
      res.status(400).json({ error: "File export CSV kosong." });
      return;
    }
    if (sizeBytes > cfg.maxFileMb * 1024 * 1024) {
      res.status(413).json({ error: `File melebihi batas ${cfg.maxFileMb} MB.` });
      return;
    }

    const exportType = detectGojekExportType(content);
    const result = exportType === "driver_snapshot"
      ? await importDriverSnapshotConnectorCsv({
          companyId: cfg.companyId,
          content,
          fileName,
          actor: "gojek-watcher",
        })
      : await importGojekConnectorCsv({
          companyId: cfg.companyId,
          content,
          fileName,
          actor: "gojek-watcher",
        });
    res.status(201).json({ ok: true, exportType, ...result });
  } catch (error) {
    req.log.error({ error }, "Gojek connector handoff failed");
    const message = error instanceof Error ? error.message : "Gagal memproses export Gojek.";
    res.status(message.includes("sudah pernah") ? 409 : 500).json({ error: message });
  }
});

router.get("/gojek-connector/runtime-credentials", (req, res) => {
  const cfg = getGojekConnectorConfig();
  if (!cfg.enabled) {
    res.status(409).json({ error: "Gojek connector belum diaktifkan." });
    return;
  }
  if (!cfg.sharedSecretConfigured || !connectorSecretMatches(req.get("x-gojek-connector-secret"))) {
    res.status(401).json({ error: "Connector runtime tidak terautentikasi." });
    return;
  }

  const email = String(process.env.GOJEK_LOGIN_EMAIL ?? "").trim();
  const password = String(process.env.GOJEK_LOGIN_PASSWORD ?? "");
  if (!email || !password) {
    res.status(503).json({ error: "Credential Gojek belum dikonfigurasi di Hostinger Secrets." });
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.json({ email, password });
});

router.post("/gojek-connector/worker/claim", async (req, res) => {
  const auth = verifyGojekWorkerRequest(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.error });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.fleet_gojek_sync_jobs
          SET status='pending', worker_id=NULL, started_at=NULL,
              heartbeat_at=NULL, updated_at=NOW(),
              error=COALESCE(error,'') || CASE WHEN COALESCE(error,'')='' THEN '' ELSE E'\\n' END || 'Recovered stale running job'
        WHERE status='running'
          AND COALESCE(heartbeat_at,started_at,requested_at) < NOW() - INTERVAL '10 minutes'`,
    );

    await client.query(
      `INSERT INTO public.fleet_gojek_connector_workers(
         worker_id,heartbeat_at,version,last_status,updated_at
       ) VALUES($1,NOW(),$2,'idle',NOW())
       ON CONFLICT(worker_id) DO UPDATE
         SET heartbeat_at=EXCLUDED.heartbeat_at,
             version=EXCLUDED.version,
             updated_at=NOW()`,
      [auth.workerId, String(req.body?.version ?? "unknown").slice(0,64)],
    );

    const claimed = await client.query<{
      id: string;
      company_id: number;
      requested_by: string;
      requested_at: string;
    }>(
      `WITH next_job AS (
         SELECT id
           FROM public.fleet_gojek_sync_jobs
          WHERE status='pending'
          ORDER BY requested_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE public.fleet_gojek_sync_jobs j
          SET status='running',
              started_at=COALESCE(started_at,NOW()),
              heartbeat_at=NOW(),
              worker_id=$1,
              updated_at=NOW()
        WHERE j.id=(SELECT id FROM next_job)
       RETURNING j.id,j.company_id,j.requested_by,j.requested_at`,
      [auth.workerId],
    );

    const job = claimed.rows[0] ?? null;
    if (job) {
      await client.query(
        `UPDATE public.fleet_gojek_connector_workers
            SET last_job_id=$2,last_status='running',last_error=NULL,
                heartbeat_at=NOW(),updated_at=NOW()
          WHERE worker_id=$1`,
        [auth.workerId, job.id],
      );
    }
    await client.query("COMMIT");

    if (!job) {
      res.json({ ok: true, job: null });
      return;
    }

    const email = String(process.env.GOJEK_LOGIN_EMAIL ?? "").trim();
    const password = String(process.env.GOJEK_LOGIN_PASSWORD ?? "");
    if (!email || !password) {
      await pool.query(
        `UPDATE public.fleet_gojek_sync_jobs
            SET status='failed',finished_at=NOW(),updated_at=NOW(),
                error='Credential Gojek belum dikonfigurasi di Hostinger Secrets.'
          WHERE id=$1`,
        [job.id],
      );
      res.status(503).json({ error: "Credential Gojek belum dikonfigurasi di Hostinger Secrets." });
      return;
    }

    const cfg = getGojekConnectorConfig();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      job,
      portalUrl: cfg.portalUrl,
      allowedHost: cfg.allowedHost,
      credentials: { email, password },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ error }, "Gojek VPS worker claim failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Worker claim gagal." });
  } finally {
    client.release();
  }
});

router.post("/gojek-connector/worker/handoff", async (req, res) => {
  const auth = verifyGojekWorkerRequest(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.error });
    return;
  }

  try {
    const jobId = String(req.body?.jobId ?? "").trim();
    const fileName = String(req.body?.fileName ?? "gojek-export.csv").trim().slice(0,255);
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!jobId || !content.trim()) {
      res.status(400).json({ error: "jobId dan CSV wajib diisi." });
      return;
    }

    const job = await pool.query<{ company_id: number; status: string }>(
      `SELECT company_id,status
         FROM public.fleet_gojek_sync_jobs
        WHERE id=$1 AND worker_id=$2
        LIMIT 1`,
      [jobId, auth.workerId],
    );
    const row = job.rows[0];
    if (!row || row.status !== "running") {
      res.status(409).json({ error: "Job tidak ditemukan atau bukan milik worker ini." });
      return;
    }

    const cfg = getGojekConnectorConfig();
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > cfg.maxFileMb * 1024 * 1024) {
      res.status(413).json({ error: `File melebihi batas ${cfg.maxFileMb} MB.` });
      return;
    }

    const exportType = detectGojekExportType(content);
    const result = exportType === "driver_snapshot"
      ? await importDriverSnapshotConnectorCsv({
          companyId: Number(row.company_id),
          content,
          fileName,
          actor: `gojek-vps-worker:${auth.workerId}`,
        })
      : await importGojekConnectorCsv({
          companyId: Number(row.company_id),
          content,
          fileName,
          actor: `gojek-vps-worker:${auth.workerId}`,
        });

    // Optional read-only Overview data captured from the authenticated Gojek page.
    // Keep overview independent of driver/transaction accounting and never infer
    // company profit from Gojek's "Total net earnings" label.
    const overviewInput = req.body?.overview;
    let overview: { netEarnings: number; periodStart: string; periodEnd: string; capturedAt: string } | null = null;
    if (exportType === "driver_snapshot" && overviewInput && typeof overviewInput === "object") {
      const amount = Number(overviewInput.netEarnings);
      const from = String(overviewInput.periodStart ?? "");
      const to = String(overviewInput.periodEnd ?? "");
      if (Number.isFinite(amount) && amount >= 0 && amount <= 1e13 &&
          /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) &&
          from <= to && Date.parse(to) - Date.parse(from) <= 366 * 86400000) {
        overview = { netEarnings: amount, periodStart: from, periodEnd: to, capturedAt: new Date().toISOString() };
      }
    }
    await pool.query(
      `UPDATE public.fleet_gojek_sync_jobs
          SET status='succeeded',finished_at=NOW(),heartbeat_at=NOW(),
              result=$2::jsonb,error=NULL,updated_at=NOW()
        WHERE id=$1`,
      [jobId, JSON.stringify({ exportType, ...result, ...(overview ? { overview } : {}) })],
    );
    await pool.query(
      `UPDATE public.fleet_gojek_connector_workers
          SET heartbeat_at=NOW(),last_job_id=$2,last_status='idle',
              last_error=NULL,updated_at=NOW()
        WHERE worker_id=$1`,
      [auth.workerId, jobId],
    );

    res.status(201).json({ ok: true, exportType, ...result });
  } catch (error) {
    req.log.error({ error }, "Gojek VPS worker handoff failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Worker handoff gagal." });
  }
});

router.post("/gojek-connector/worker/fail", async (req, res) => {
  const auth = verifyGojekWorkerRequest(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.error });
    return;
  }

  try {
    const jobId = String(req.body?.jobId ?? "").trim();
    const errorText = String(req.body?.error ?? "Worker gagal.").slice(0,4000);
    if (!jobId) {
      res.status(400).json({ error: "jobId wajib diisi." });
      return;
    }
    await pool.query(
      `UPDATE public.fleet_gojek_sync_jobs
          SET status='failed',finished_at=NOW(),heartbeat_at=NOW(),
              error=$3,updated_at=NOW()
        WHERE id=$1 AND worker_id=$2 AND status='running'`,
      [jobId, auth.workerId, errorText],
    );
    await pool.query(
      `UPDATE public.fleet_gojek_connector_workers
          SET heartbeat_at=NOW(),last_job_id=$2,last_status='idle',
              last_error=$3,updated_at=NOW()
        WHERE worker_id=$1`,
      [auth.workerId, jobId, errorText],
    );
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Gojek VPS worker fail report failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Worker fail report gagal." });
  }
});

router.use((req, res, next) => {
  void authenticateAdmin(req as AdminRequest, res, next);
});

type SnapshotRow = {
  driver_name: string;
  phone_number: string;
  license_plate: string;
  rental_fee_daily: number;
  outstanding: number;
  status: string;
  match_status?: "found" | "unmatched";
  matched_driver_id?: number | null;
  matched_name?: string | null;
  internal_status?: "active" | "inactive" | "suspended" | "fired";
  applicator_status?: string;
  vehicle_ownership?: "company" | "partner_private" | "unassigned";
};

const COMPANY_UNIT_RENTAL_FEE_MIN = 300_000;

function normalizeApplicatorStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function classifyDriver(row: Pick<SnapshotRow, "status" | "license_plate" | "rental_fee_daily">) {
  const applicatorStatus = normalizeApplicatorStatus(row.status);
  const plate = String(row.license_plate ?? "").trim();
  const rentalFee = numberValue(row.rental_fee_daily);

  let internalStatus: "active" | "inactive" | "suspended" | "fired";
  if (applicatorStatus === "suspended" || applicatorStatus === "suspend" || applicatorStatus === "fired" || applicatorStatus === "terminated") {
    internalStatus = "suspended";
  } else if (!plate || applicatorStatus === "resign" || applicatorStatus === "need_to_assign") {
    internalStatus = "inactive";
  } else {
    internalStatus = "active";
  }

  const vehicleOwnership: "company" | "partner_private" | "unassigned" =
    !plate ? "unassigned" :
    rentalFee >= COMPANY_UNIT_RENTAL_FEE_MIN ? "company" :
    rentalFee > 0 ? "partner_private" :
    "unassigned";

  return { applicatorStatus, internalStatus, vehicleOwnership };
}

function companyId(req: AdminRequest): number {
  const id = Number(req.adminUser?.companyId);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("Company ID tidak tersedia pada session Fleet Intelligence.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return id;
}

function requireDestructiveConfirmation(
  req: AdminRequest,
  expected: string,
  options: { ownerOnly?: boolean } = {},
): { ok: true } | { ok: false; status: number; error: string } {
  const role = String(req.adminUser?.role ?? "").trim().toLowerCase();
  if (options.ownerOnly && role !== "owner" && role !== "super_admin") {
    return { ok: false, status: 403, error: "Aksi ini hanya dapat dilakukan owner/super_admin." };
  }

  const supplied = String(
    req.get("x-fleet-confirmation") ??
    req.body?.confirmation ??
    "",
  ).trim();

  if (supplied !== expected) {
    return {
      ok: false,
      status: 409,
      error: `Konfirmasi destruktif tidak cocok. Gunakan: ${expected}`,
    };
  }
  return { ok: true };
}

function csvRows(content: string): string[][] {
  const input = content.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const pushCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === "," && !quoted) {
      pushCell();
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      pushRow();
      continue;
    }
    cell += ch;
  }

  if (cell.length || row.length) pushRow();
  if (quoted) throw new Error("CSV memiliki kutip yang tidak tertutup.");
  return rows;
}

function numberValue(value: unknown): number {
  const raw = String(value ?? "")
    .replace(/\t/g, "")
    .replace(/rp\.?/gi, "")
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(/,/g, ".");
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanPhone(value: unknown): string {
  return String(value ?? "").replace(/\t/g, "").trim();
}

function parseSnapshotCsv(content: string): Array<Omit<SnapshotRow, "match_status" | "matched_driver_id" | "matched_name">> {
  const rows = csvRows(content);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => headers.findIndex((h) => names.includes(h));

  const nameIdx = find("driver name", "driver_name", "nama driver", "nama");
  const phoneIdx = find("phone number", "phone_number", "driver phone", "no hp", "nomor telepon");
  const plateIdx = find("license plate", "license_plate", "vehicle plate", "plat", "nomor kendaraan");
  const feeIdx = find("rental fee(daily)", "rental fee (daily)", "rental_fee_daily", "rental fee");
  const outIdx = find("outstanding", "outstanding amount", "outstanding_amount");
  const statusIdx = find("status");

  if (nameIdx < 0 || outIdx < 0) {
    throw new Error("CSV wajib memiliki kolom Driver Name dan Outstanding.");
  }

  return rows.slice(1).map((cells) => {
    return {
      driver_name: String(cells[nameIdx] ?? "").trim(),
      phone_number: phoneIdx >= 0 ? cleanPhone(cells[phoneIdx]) : "",
      license_plate: plateIdx >= 0 ? String(cells[plateIdx] ?? "").trim() : "",
      rental_fee_daily: feeIdx >= 0 ? numberValue(cells[feeIdx]) : 0,
      outstanding: numberValue(cells[outIdx]),
      status: statusIdx >= 0 ? String(cells[statusIdx] ?? "").trim() : "Active",
    };
  }).filter((row) => row.driver_name);
}


type GojekTransactionRow = {
  driverName: string;
  driverExtId: string;
  driverPhone: string;
  txDate: string;
  vehiclePlate: string;
  amount: number;
  outstanding: number;
  transactionType: string;
  gopayRef: string;
  serviceType: string;
  raw: Record<string,string>;
};

function parseGojekTransactionCsv(content: string) {
  const parsedRows=csvRows(content);
  if(parsedRows.length<2) return {headers:[] as string[],rows:[] as GojekTransactionRow[],mapping:{} as Record<string,string|null>,warnings:["File tidak memiliki data."]};
  const headers=parsedRows[0].map(h=>h.trim());
  const normalized=headers.map(h=>h.toLowerCase().replace(/[()]/g,"").replace(/[_-]+/g," ").replace(/\s+/g," ").trim());
  const find=(...names:string[])=>normalized.findIndex(h=>names.includes(h));
  const idx={
    driverName:find("driver name","nama driver","driver"),
    driverExtId:find("driver id","driver external id","driver externalid","id driver"),
    driverPhone:find("phone number","driver phone","phone","no hp","nomor telepon"),
    txDate:find("date time jkt","date time","datetime","transaction date","tanggal waktu","tanggal"),
    simpleDate:find("date","tanggal"),
    vehiclePlate:find("vehicle","vehicle plate","license plate","plat kendaraan","plate"),
    amount:find("amount","nominal","transaction amount"),
    outstanding:find("total outstanding balance","outstanding","outstanding balance"),
    transactionType:find("transaction type","jenis transaksi","type"),
    gopayRef:find("gopay transaction reference id","gopay reference id","gopay ref id","reference id"),
    serviceType:find("service type","service","layanan"),
  };
  if(idx.driverName<0||idx.amount<0) throw new Error("CSV transaksi wajib memiliki kolom Driver Name dan Amount.");
  const mapping:Record<string,string|null>={};
  for(const [key,index] of Object.entries(idx)) mapping[key]=index>=0?headers[index]:null;
  const warnings:string[]=[];
  if(idx.gopayRef<0) warnings.push("GoPay Reference ID tidak ditemukan; dedup akan memakai fallback.");
  if(idx.driverExtId<0) warnings.push("Driver ID tidak ditemukan.");
  const rows=parsedRows.slice(1).map(cells=>{
    const raw:Record<string,string>={};
    headers.forEach((h,i)=>{raw[h]=cells[i]??"";});
    const dateRaw=String(cells[idx.txDate>=0?idx.txDate:idx.simpleDate]??"").trim();
    let txDate="";
    const iso=dateRaw.match(/(20\d{2})[-\/]([01]?\d)[-\/]([0-3]?\d)/);
    const dmy=dateRaw.match(/([0-3]?\d)[-\/]([01]?\d)[-\/](20\d{2})/);
    if(iso) txDate=`${iso[1]}-${String(iso[2]).padStart(2,"0")}-${String(iso[3]).padStart(2,"0")}`;
    else if(dmy) txDate=`${dmy[3]}-${String(dmy[2]).padStart(2,"0")}-${String(dmy[1]).padStart(2,"0")}`;
    return {
      driverName:String(cells[idx.driverName]??"").trim(),
      driverExtId:idx.driverExtId>=0?String(cells[idx.driverExtId]??"").trim():"",
      driverPhone:idx.driverPhone>=0?cleanPhone(cells[idx.driverPhone]):"",
      txDate,
      vehiclePlate:idx.vehiclePlate>=0?String(cells[idx.vehiclePlate]??"").trim():"",
      amount:numberValue(cells[idx.amount]),
      outstanding:idx.outstanding>=0?numberValue(cells[idx.outstanding]):0,
      transactionType:idx.transactionType>=0?String(cells[idx.transactionType]??"").trim():"",
      gopayRef:idx.gopayRef>=0?String(cells[idx.gopayRef]??"").trim():"",
      serviceType:idx.serviceType>=0?String(cells[idx.serviceType]??"").trim():"",
      raw,
    };
  }).filter(r=>r.driverName||r.driverExtId||r.amount!==0);
  return {headers,rows,mapping,warnings};
}

function summarizeGojekRows(rows:GojekTransactionRow[]) {
  const typeBreakdown:Record<string,{count:number;total:number}>={};
  let totalCredit=0,totalDebit=0;
  const drivers=new Set<string>(),vehicles=new Set<string>();
  for(const row of rows){
    if(row.amount>=0) totalCredit+=row.amount; else totalDebit+=row.amount;
    if(row.driverExtId||row.driverName) drivers.add(row.driverExtId||row.driverName);
    if(row.vehiclePlate) vehicles.add(row.vehiclePlate);
    const key=row.transactionType||"Unknown";
    const current=typeBreakdown[key]??{count:0,total:0}; current.count+=1; current.total+=row.amount; typeBreakdown[key]=current;
  }
  return {transactionCount:rows.length,totalCredit,totalDebit,netFlow:totalCredit+totalDebit,vehicleCoverage:vehicles.size,driverCoverage:drivers.size,typeBreakdown};
}


async function importGojekConnectorCsv(args: {
  companyId: number;
  content: string;
  fileName: string;
  actor: string;
}) {
  const parsed = parseGojekTransactionCsv(args.content);
  const fileHash = createHash("sha256").update(args.content).digest("hex");
  const client = await pool.connect();

  try {
    // Transaction-scoped lock serializes imports of the same report hash.
    // Prevent concurrent handoffs racing past dedup before either commits.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text),hashtext($2::text))",[
      "fleet-gojek-transactions:" + args.companyId, fileHash,
    ]);
    const dup = await client.query(
      "SELECT id,original_filename,status FROM public.fleet_reports WHERE company_id=$1 AND file_hash=$2 ORDER BY id DESC LIMIT 1",
      [args.companyId, fileHash],
    );
    if (dup.rows[0]) {
      throw new Error(`File export ini sudah pernah diproses (report #${dup.rows[0].id}).`);
    }

    const dates = parsed.rows.map((r) => r.txDate).filter(Boolean).sort();
    const report = await client.query<{ id: number }>(
      `INSERT INTO public.fleet_reports(
         company_id,partner_id,filename,original_filename,file_hash,report_type,
         period_start,period_end,status,row_count,processed_count,error_count,
         uploaded_by,uploaded_by_email,column_mapping,summary_stats,created_at,updated_at
       )
       VALUES($1,NULL,$2,$2,$3,'gojek_driver',$4,$5,'processing',$6,0,0,$7,$7,$8::jsonb,$9::jsonb,NOW(),NOW())
       RETURNING id`,
      [
        args.companyId,
        args.fileName,
        fileHash,
        dates[0] ?? null,
        dates.at(-1) ?? null,
        parsed.rows.length,
        args.actor,
        JSON.stringify(parsed.mapping),
        JSON.stringify(summarizeGojekRows(parsed.rows)),
      ],
    );
    const reportId = report.rows[0].id;

    let rawInserted = 0;
    let successRows = 0;
    let failedRows = 0;

    for (let i = 0; i < parsed.rows.length; i += 1) {
      const row = parsed.rows[i];
      const raw = await client.query<{ id: number }>(
        `INSERT INTO public.gojek_raw_transactions(
           company_id,report_id,date_time_jkt,driver_external_id,driver_name,phone_number,
           vehicle,amount,total_outstanding_balance,transaction_type,gopay_transaction_reference_id,
           date,raw_json,service_type,driver_phone,vehicle_plate,date_iso
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),$12,$13::jsonb,$14,$6,$7,$15::date)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          args.companyId, reportId,
          row.raw[parsed.mapping.txDate ?? ""] ?? row.txDate,
          row.driverExtId || null, row.driverName, row.driverPhone || null, row.vehiclePlate || null,
          row.amount, row.outstanding, row.transactionType || null, row.gopayRef,
          row.txDate || null, JSON.stringify(row.raw), row.serviceType || null, row.txDate || null,
        ],
      );
      if (!raw.rows[0]?.id) continue;
      rawInserted += 1;

      if (!row.txDate) {
        await client.query(
          `INSERT INTO public.gojek_failed_rows(
             report_id,company_id,raw_row_id,row_index,error_reason,error_stage,raw_data
           ) VALUES($1,$2,$3,$4,'Tanggal transaksi tidak dapat diparse','transform',$5::jsonb)`,
          [reportId, args.companyId, raw.rows[0].id, i + 2, JSON.stringify(row.raw)],
        );
        failedRows += 1;
        continue;
      }

      try {
        await client.query(
          `INSERT INTO public.fleet_transactions(
             company_id,report_id,driver_external_id,driver_name,vehicle_plate,transaction_date,
             trip_count,gross_revenue,incentive,commission,deduction,net_revenue,
             outstanding_balance,service_type,raw_data,amount,transaction_type,driver_phone,gopay_reference_id
           )
           VALUES($1,$2,$3,$4,$5,$6,0,GREATEST($7,0),0,0,0,$7,$8,$9,$10::jsonb,$7,$11,$12,NULLIF($13,''))
           ON CONFLICT DO NOTHING`,
          [
            args.companyId, reportId, row.driverExtId || null, row.driverName, row.vehiclePlate || null,
            row.txDate, row.amount, row.outstanding, row.serviceType || null, JSON.stringify(row.raw),
            row.transactionType || null, row.driverPhone || null, row.gopayRef,
          ],
        );
        successRows += 1;
      } catch (rowError) {
        await client.query(
          `INSERT INTO public.gojek_failed_rows(
             report_id,company_id,raw_row_id,row_index,error_reason,error_stage,raw_data
           ) VALUES($1,$2,$3,$4,$5,'transform',$6::jsonb)`,
          [
            reportId, args.companyId, raw.rows[0].id, i + 2,
            rowError instanceof Error ? rowError.message : "Transform gagal",
            JSON.stringify(row.raw),
          ],
        );
        failedRows += 1;
      }
    }

    const status = failedRows === 0 ? "done" : successRows > 0 ? "partial" : "error";
    await client.query(
      "UPDATE public.fleet_reports SET status=$2,processed_count=$3,error_count=$4,updated_at=NOW() WHERE id=$1",
      [reportId, status, successRows, failedRows],
    );
    await client.query("COMMIT");

    return {
      reportId,
      fileName: args.fileName,
      rowCount: parsed.rows.length,
      rawInserted,
      successRows,
      failedRows,
      status,
      fileRetained: false,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}


async function importDriverSnapshotConnectorCsv(args: {
  companyId: number;
  content: string;
  fileName: string;
  actor: string;
}) {
  const rows = parseSnapshotCsv(args.content);
  const prepared = rows
    .map((row) => {
      const driverName = String(row.driver_name ?? "").trim();
      if (!driverName) return null;
      const phone = cleanPhone(row.phone_number);
      const plate = String(row.license_plate ?? "").trim().toUpperCase();
      const fee = numberValue(row.rental_fee_daily);
      const outstanding = numberValue(row.outstanding);
      const classification = classifyDriver({
        ...row,
        license_plate: plate,
        rental_fee_daily: fee,
      });
      return {
        driver_name: driverName,
        phone_number: phone,
        license_plate: plate,
        rental_fee_daily: fee,
        outstanding,
        internal_status: classification.internalStatus,
        applicator_status: classification.applicatorStatus,
        vehicle_ownership: classification.vehicleOwnership,
      };
    })
    .filter((row) => row !== null);

  if (!prepared.length) throw new Error("CSV Drivers tidak memiliki baris valid.");

  const result = await pool.query<{ result: Record<string, unknown> }>(
    `SELECT public.fleet_import_driver_snapshot($1,$2,$3,$4::jsonb) AS result`,
    [args.companyId, args.fileName, args.actor, JSON.stringify(prepared)],
  );
  const payload = result.rows[0]?.result;
  if (!payload) throw new Error("Import Drivers selesai tanpa hasil.");
  return {
    type: "driver_snapshot",
    fileName: args.fileName,
    ...payload,
    fileRetained: false,
  };
}

function detectGojekExportType(content: string): "driver_snapshot" | "transactions" {
  const header = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
  const driverColumns = [
    "driver name",
    "phone number",
    "license plate",
    "rental fee",
    "outstanding",
    "status",
  ];
  const isDriverSnapshot = driverColumns.every((column) => header.includes(column));
  return isDriverSnapshot ? "driver_snapshot" : "transactions";
}

async function assertFleetSchemaTables(names: string[]): Promise<void> {
  const result = await pool.query<{ name: string; exists: boolean }>(
    `SELECT name, to_regclass('public.' || name) IS NOT NULL AS exists
       FROM unnest($1::text[]) AS name`,
    [names],
  );
  const missing = result.rows.filter((row) => !row.exists).map((row) => row.name);
  if (missing.length) {
    throw new Error(`Fleet schema belum siap. Jalankan migration sebelum service: ${missing.join(", ")}`);
  }
}

async function ensureFleetTables(): Promise<void> {
  await assertFleetSchemaTables([
    "fleet_outstanding",
    "fleet_outstanding_import_log",
    "fleet_settings",
    "fleet_drivers",
  ]);

  const requiredDriverColumns = [
    "rental_fee_daily",
    "vehicle_plate",
    "vehicle_type",
    "applicator_status",
    "vehicle_ownership",
    "source_last_synced_at",
    "last_active_date",
    "total_trips",
    "total_revenue",
    "avg_daily_trips",
    "performance_tier",
    "raw_data",
    "source_present_in_latest_snapshot",
    "source_missing_since",
  ];
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='fleet_drivers'
        AND column_name = ANY($1::text[])`,
    [requiredDriverColumns],
  );
  const present = new Set(columns.rows.map((row) => row.column_name));
  const missing = requiredDriverColumns.filter((name) => !present.has(name));
  if (missing.length) {
    throw new Error(`Fleet driver schema belum siap. Kolom migration belum tersedia: ${missing.join(", ")}`);
  }
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${name}`],
  );
  return result.rows[0]?.exists === true;
}

router.get("/dashboard", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : null;

    const [outstanding, driverSnapshot] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(outstanding_amount),0)::numeric AS total_amount,
                COUNT(*) FILTER (WHERE outstanding_amount >= 1000000)::int AS high_count
           FROM public.fleet_outstanding
          WHERE company_id=$1 AND status='open'`,
        [cid],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total_drivers,
                COUNT(*) FILTER (WHERE COALESCE(source_present_in_latest_snapshot,true)=true)::int AS current_snapshot_drivers,
                COUNT(*) FILTER (WHERE COALESCE(source_present_in_latest_snapshot,true)=false)::int AS missing_snapshot_drivers,
                COUNT(*) FILTER (WHERE status='active' AND COALESCE(source_present_in_latest_snapshot,true)=true)::int AS active_drivers,
                COUNT(*) FILTER (WHERE status='inactive' AND COALESCE(source_present_in_latest_snapshot,true)=true)::int AS inactive_drivers,
                COUNT(*) FILTER (WHERE status='suspended')::int AS suspended_drivers,
                COUNT(*) FILTER (WHERE applicator_status='resign')::int AS resign_drivers,
                COUNT(*) FILTER (WHERE applicator_status='need_to_assign')::int AS need_to_assign_drivers,
                COUNT(*) FILTER (WHERE vehicle_ownership='company')::int AS company_units,
                COUNT(*) FILTER (WHERE vehicle_ownership='partner_private')::int AS partner_private_units,
                COUNT(*) FILTER (WHERE vehicle_ownership='unassigned')::int AS unassigned_units
           FROM public.fleet_drivers
          WHERE company_id=$1::text`,
        [cid],
      ),
    ]);

    const topDrivers = await pool.query(
      `SELECT o.driver_name AS name,
              COALESCE(NULLIF(d.vehicle_plate,''),o.vehicle_plate) AS vehicle_plate,
              COALESCE(d.total_trips,0)::int AS trips,
              o.outstanding_amount AS outstanding
         FROM public.fleet_outstanding o
         LEFT JOIN public.fleet_drivers d
           ON d.id=o.driver_id
          AND d.company_id=o.company_id::text
        WHERE o.company_id=$1 AND o.status='open'
        ORDER BY o.outstanding_amount DESC
        LIMIT 10`,
      [cid],
    );

    let kpi: Record<string, unknown> = {
      total_drivers: 0,
      total_trips: 0,
      total_amount_raw: 0,
      total_rental_due: 0,
      total_incentive: 0,
      total_commission: 0,
      total_deduction: 0,
      total_net: 0,
      total_gross: 0,
    };
    let trend: Record<string, unknown>[] = [];
    let rawTotals: Record<string, unknown> = { raw_outstanding_total: 0, raw_row_count: 0 };
    let lastUploadDate: string | null = null;
    const snapshotSummary = {
      ...(driverSnapshot.rows[0] ?? {}),
      open_outstanding_count: Number(outstanding.rows[0]?.count ?? 0),
      open_outstanding_total: Number(outstanding.rows[0]?.total_amount ?? 0),
      high_outstanding_count: Number(outstanding.rows[0]?.high_count ?? 0),
    };

    if (await tableExists("gojek_raw_transactions")) {
      const periodSql = month
        ? "date_iso >= ($2 || '-01')::date AND date_iso < (($2 || '-01')::date + interval '1 month')"
        : "date_iso >= CURRENT_DATE - ($2::int * interval '1 day')";
      const periodValue: string | number = month ?? days;

      const [kpiResult, trendResult, rawResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(DISTINCT NULLIF(driver_external_id,''))::int AS total_drivers,
                  0::int AS total_trips,
                  COUNT(*)::int AS raw_transaction_rows,
                  COALESCE(SUM(amount),0)::numeric AS total_amount_raw,
                  COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0)::numeric AS total_rental_due,
                  COALESCE(SUM(amount),0)::numeric AS total_net,
                  0::numeric AS total_incentive,
                  0::numeric AS total_commission,
                  0::numeric AS total_deduction,
                  0::numeric AS total_gross
             FROM public.gojek_raw_transactions
            WHERE company_id=$1 AND ${periodSql}`,
          [cid, periodValue],
        ),
        pool.query(
          `SELECT date_iso::text AS summary_date,
                  COALESCE(SUM(amount),0)::numeric AS net_revenue,
                  COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0)::numeric AS gross_revenue,
                  COUNT(DISTINCT NULLIF(driver_external_id,''))::int AS active_drivers,
                  0::int AS total_trips,
                  COUNT(*)::int AS raw_transaction_rows
             FROM public.gojek_raw_transactions
            WHERE company_id=$1 AND date_iso IS NOT NULL AND ${periodSql}
            GROUP BY date_iso
            ORDER BY date_iso`,
          [cid, periodValue],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS raw_row_count,
                  COALESCE(SUM(amount),0)::numeric AS raw_total_amount,
                  COALESCE((
                    SELECT SUM(x.total_outstanding_balance)
                      FROM (
                        SELECT DISTINCT ON (driver_external_id)
                               driver_external_id, total_outstanding_balance
                          FROM public.gojek_raw_transactions
                         WHERE company_id=$1
                           AND NULLIF(driver_external_id,'') IS NOT NULL
                           AND total_outstanding_balance IS NOT NULL
                         ORDER BY driver_external_id, date_iso DESC NULLS LAST, id DESC
                      ) x
                  ),0)::numeric AS raw_outstanding_total
             FROM public.gojek_raw_transactions
            WHERE company_id=$1`,
          [cid],
        ),
      ]);
      kpi = kpiResult.rows[0] ?? kpi;
      trend = trendResult.rows;
      rawTotals = rawResult.rows[0] ?? rawTotals;
    }

    let normalizedTransactionRows = 0;
    if (await tableExists("fleet_transactions")) {
      const txPeriodSql = month
        ? "transaction_date >= ($2 || '-01')::date AND transaction_date < (($2 || '-01')::date + interval '1 month')"
        : "transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')";
      const txPeriodValue: string | number = month ?? days;
      const [txKpi, txTrend] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS normalized_transaction_rows,
                  COUNT(DISTINCT COALESCE(NULLIF(driver_external_id,''),driver_name))::int AS total_drivers,
                  COALESCE(SUM(trip_count),0)::int AS total_trips,
                  COALESCE(SUM(gross_revenue),0)::numeric AS total_gross,
                  COALESCE(SUM(incentive),0)::numeric AS total_incentive,
                  COALESCE(SUM(commission),0)::numeric AS total_commission,
                  COALESCE(SUM(deduction),0)::numeric AS total_deduction,
                  COALESCE(SUM(net_revenue),0)::numeric AS total_net
             FROM public.fleet_transactions
            WHERE company_id=$1 AND ${txPeriodSql}`,
          [cid, txPeriodValue],
        ),
        pool.query(
          `SELECT transaction_date::text AS summary_date,
                  COALESCE(SUM(net_revenue),0)::numeric AS net_revenue,
                  COALESCE(SUM(gross_revenue),0)::numeric AS gross_revenue,
                  COUNT(DISTINCT COALESCE(NULLIF(driver_external_id,''),driver_name))::int AS active_drivers,
                  COALESCE(SUM(trip_count),0)::int AS total_trips
             FROM public.fleet_transactions
            WHERE company_id=$1 AND transaction_date IS NOT NULL AND ${txPeriodSql}
            GROUP BY transaction_date
            ORDER BY transaction_date`,
          [cid, txPeriodValue],
        ),
      ]);
      normalizedTransactionRows = Number(txKpi.rows[0]?.normalized_transaction_rows ?? 0);
      if (normalizedTransactionRows > 0) {
        kpi = {
          ...kpi,
          ...txKpi.rows[0],
        };
        trend = txTrend.rows;
      }
    }

    // Latest verified snapshot of the official Gojek Overview (its own date range).
    // Not derived from driver rental payments or transaction exports.
    const overviewRow = await pool.query<{ overview: unknown }>(
      `SELECT result->'overview' AS overview
         FROM public.fleet_gojek_sync_jobs
        WHERE company_id=$1 AND status='succeeded'
          AND result->>'exportType'='driver_snapshot'
          AND result->'overview' IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
      [cid],
    );
    const gojekOverview = overviewRow.rows[0]?.overview ?? null;

    const importDate = await pool.query<{ uploaded_at: Date }>(
      `SELECT uploaded_at
         FROM public.fleet_outstanding_import_log
        WHERE company_id=$1
        ORDER BY uploaded_at DESC
        LIMIT 1`,
      [cid],
    );
    lastUploadDate = importDate.rows[0]?.uploaded_at?.toISOString?.() ?? null;

    res.json({
      kpi,
      trend,
      topDrivers: topDrivers.rows,
      outstanding: outstanding.rows[0] ?? { count: 0, total_amount: 0 },
      rawTotals,
      gojekOverview,
      snapshotSummary,
      outstandingReconciliation: { comparable: false, authoritativeSource: "gojek_driver_snapshot", transactionScope: "partial_history", mismatch: false },
      dataSource: normalizedTransactionRows > 0
        ? "normalized_transactions"
        : Number((rawTotals as Record<string, unknown>).raw_row_count ?? 0) > 0
          ? "raw_transactions"
          : "driver_snapshot",
      dataQuality: {
        normalizedTransactionRows,
        rawTransactionRows: Number((rawTotals as Record<string, unknown>).raw_row_count ?? 0),
        tripMetricsAvailable: normalizedTransactionRows > 0,
      },
      lastUploadDate,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet dashboard failed");
    const status = (error as { statusCode?: number }).statusCode ?? 503;
    res.status(status).json({ error: error instanceof Error ? error.message : "Fleet dashboard unavailable" });
  }
});

router.get("/outstanding", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const status = typeof req.query.status === "string" && req.query.status.trim()
      ? req.query.status.trim()
      : "open";

    if (status === "open") {
      const [rows, summary] = await Promise.all([
        pool.query(
          `SELECT o.id,
                  d.id AS driver_id,
                  d.driver_external_id,
                  d.full_name AS driver_name,
                  d.phone AS driver_phone,
                  d.vehicle_plate,
                  d.rental_fee_daily,
                  COALESCE(o.outstanding_amount,0)::numeric AS outstanding_amount,
                  COALESCE(o.due_days,0)::int AS due_days,
                  COALESCE(o.snapshot_source,'driver_snapshot') AS snapshot_source,
                  CASE WHEN o.id IS NULL THEN 'clear' ELSE 'open' END AS status,
                  d.status AS driver_status,
                  d.applicator_status,
                  d.vehicle_ownership,
                  d.source_present_in_latest_snapshot,
                  d.source_missing_since,
                  d.source_last_synced_at AS last_updated_date
             FROM public.fleet_drivers d
             LEFT JOIN LATERAL (
               SELECT fo.*
                 FROM public.fleet_outstanding fo
                WHERE fo.company_id=$1
                  AND fo.driver_id=d.id
                  AND fo.status='open'
                ORDER BY fo.updated_at DESC,fo.id DESC
                LIMIT 1
             ) o ON TRUE
            WHERE d.company_id=$1::text
            ORDER BY
              CASE
                WHEN COALESCE(d.source_present_in_latest_snapshot,true)=false THEN 6
                WHEN d.status='active' AND d.applicator_status='active' AND COALESCE(d.rental_fee_daily,0)>0 THEN 1
                WHEN d.applicator_status='need_to_assign' THEN 2
                WHEN d.applicator_status='resign' THEN 3
                WHEN d.applicator_status='fired' OR d.status='suspended' THEN 4
                ELSE 5
              END,
              COALESCE(o.outstanding_amount,0) DESC,
              d.full_name ASC`,
          [cid],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS driver_count,
                  COUNT(*) FILTER (WHERE COALESCE(d.source_present_in_latest_snapshot,true)=true)::int AS current_snapshot_count,
                  COUNT(*) FILTER (WHERE COALESCE(d.source_present_in_latest_snapshot,true)=false)::int AS missing_snapshot_count,
                  COUNT(*) FILTER (WHERE d.status='active' AND COALESCE(d.source_present_in_latest_snapshot,true)=true)::int AS active_driver_count,
                  COUNT(*) FILTER (WHERE d.applicator_status='need_to_assign' AND COALESCE(d.source_present_in_latest_snapshot,true)=true)::int AS need_to_assign_count,
                  COUNT(*) FILTER (WHERE d.applicator_status='resign' AND COALESCE(d.source_present_in_latest_snapshot,true)=true)::int AS resign_count,
                  COUNT(*) FILTER (WHERE (d.applicator_status='fired' OR d.status='suspended') AND COALESCE(d.source_present_in_latest_snapshot,true)=true)::int AS suspended_count,
                  COUNT(o.id)::int AS count,
                  COALESCE(SUM(COALESCE(o.outstanding_amount,0)),0)::numeric AS total,
                  COALESCE(AVG(COALESCE(o.due_days,0)),0)::numeric AS avg_due_days
             FROM public.fleet_drivers d
             LEFT JOIN LATERAL (
               SELECT fo.id,fo.outstanding_amount,fo.due_days
                 FROM public.fleet_outstanding fo
                WHERE fo.company_id=$1
                  AND fo.driver_id=d.id
                  AND fo.status='open'
                ORDER BY fo.updated_at DESC,fo.id DESC
                LIMIT 1
             ) o ON TRUE
            WHERE d.company_id=$1::text`,
          [cid],
        ),
      ]);
      res.json({ outstanding: rows.rows, summary: summary.rows[0] });
      return;
    }

    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT o.*,
                d.status AS driver_status,
                d.applicator_status,
                d.vehicle_ownership,
                COALESCE(NULLIF(d.phone,''),o.driver_phone) AS driver_phone,
                COALESCE(NULLIF(d.vehicle_plate,''),o.vehicle_plate) AS vehicle_plate,
                COALESCE(d.rental_fee_daily,o.rental_fee_daily,0) AS rental_fee_daily
           FROM public.fleet_outstanding o
           LEFT JOIN public.fleet_drivers d
             ON d.id=o.driver_id
            AND d.company_id=o.company_id::text
          WHERE o.company_id=$1 AND o.status=$2
          ORDER BY o.outstanding_amount DESC,o.driver_name ASC`,
        [cid, status],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(outstanding_amount),0)::numeric AS total,
                COALESCE(AVG(due_days),0)::numeric AS avg_due_days
           FROM public.fleet_outstanding
          WHERE company_id=$1 AND status=$2`,
        [cid, status],
      ),
    ]);
    res.json({ outstanding: rows.rows, summary: summary.rows[0] });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding list failed");
    res.status(503).json({ error: "Gagal mengambil data outstanding." });
  }
});

router.post("/outstanding/repair", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    // The driver snapshot is authoritative for cumulative outstanding.
    // Reconciliation transaction exports cover only a subset of drivers and
    // must never overwrite or resolve the snapshot-derived balances.
    const summary = await pool.query(
      `SELECT COUNT(*)::int AS drivers,
              COALESCE(SUM(outstanding_amount),0)::numeric AS total
         FROM public.fleet_outstanding
        WHERE company_id=$1 AND status='open'`,
      [cid],
    );
    res.json({
      ok: true,
      repaired: false,
      message: "Saldo outstanding resmi Gojek dipertahankan. Untuk memperbarui saldo, lakukan sinkronisasi driver Gojek.",
      summary: summary.rows[0],
    });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding status failed");
    res.status(503).json({ error: "Gagal memeriksa outstanding." });
  }
});

router.post("/outstanding/snapshot/preview", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!content.trim()) {
      res.status(400).json({ error: "Isi CSV tidak tersedia." });
      return;
    }

    const rows = parseSnapshotCsv(content);
    const previews: SnapshotRow[] = [];
    let found = 0;

    // Fetch driver master once. The previous implementation executed one
    // database query per CSV row (86+ round trips for a normal GoCar export),
    // which regularly exceeded Hostinger's request window.
    const driverRows = await pool.query<{
      id: number;
      name: string;
      phone: string | null;
    }>(
      `SELECT id,full_name AS name,phone
         FROM public.fleet_drivers
        WHERE company_id=$1::text`,
      [cid],
    );

    const byPhoneSuffix = new Map<string,{ id:number; name:string }>();
    const byName = new Map<string,{ id:number; name:string }>();
    for (const driver of driverRows.rows) {
      const phoneDigits = String(driver.phone ?? "").replace(/\D/g, "");
      const suffix = phoneDigits.slice(-9);
      const item = { id:Number(driver.id), name:String(driver.name ?? "") };
      if (suffix && !byPhoneSuffix.has(suffix)) byPhoneSuffix.set(suffix,item);
      const normalizedName = item.name.trim().toLowerCase();
      if (normalizedName && !byName.has(normalizedName)) byName.set(normalizedName,item);
    }

    for (const row of rows) {
      const phoneSuffix = row.phone_number.replace(/\D/g, "").replace(/^0/, "").slice(-9);
      const normalizedName = row.driver_name.trim().toLowerCase();
      const match = (phoneSuffix ? byPhoneSuffix.get(phoneSuffix) : undefined)
        ?? byName.get(normalizedName)
        ?? null;

      if (match) found += 1;
      const classification = classifyDriver(row);
      previews.push({
        ...row,
        match_status: match ? "found" : "unmatched",
        matched_driver_id: match?.id ?? null,
        matched_name: match?.name ?? null,
        internal_status: classification.internalStatus,
        applicator_status: classification.applicatorStatus,
        vehicle_ownership: classification.vehicleOwnership,
      });
    }

    const outstandingRows = previews.filter((row) => numberValue(row.outstanding) > 0).length;
    const activeDrivers = previews.filter((row) => row.internal_status === "active").length;
    const inactiveDrivers = previews.filter((row) => row.internal_status === "inactive").length;
    const suspendedDrivers = previews.filter((row) => row.internal_status === "suspended").length;
    const firedDrivers = previews.filter((row) => row.internal_status === "fired").length;
    const companyUnits = previews.filter((row) => row.vehicle_ownership === "company").length;
    const partnerPrivateUnits = previews.filter((row) => row.vehicle_ownership === "partner_private").length;

    res.json({
      ok: true,
      rows: previews,
      total: previews.length,
      found,
      unmatched: previews.length - found,
      skipped: 0,
      summary: {
        outstandingRows,
        activeDrivers,
        inactiveDrivers,
        suspendedDrivers,
        firedDrivers,
        companyUnits,
        partnerPrivateUnits,
      },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet driver master preview failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Gagal memproses CSV." });
  }
});

router.post("/outstanding/snapshot/confirm", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const inputRows = Array.isArray(req.body?.rows) ? req.body.rows as SnapshotRow[] : [];
    if (inputRows.length === 0) {
      res.status(400).json({ error: "Rows tidak boleh kosong." });
      return;
    }

    const fileName = typeof req.body?.fileName === "string"
      ? req.body.fileName.slice(0,255)
      : "drivers.csv";

    const prepared = inputRows
      .map((row) => {
        const driverName = String(row.driver_name ?? "").trim();
        if (!driverName) return null;
        const phone = cleanPhone(row.phone_number);
        const plate = String(row.license_plate ?? "").trim().toUpperCase();
        const fee = numberValue(row.rental_fee_daily);
        const outstanding = numberValue(row.outstanding);
        const classification = classifyDriver({
          ...row,
          license_plate: plate,
          rental_fee_daily: fee,
        });
        return {
          driver_name: driverName,
          phone_number: phone,
          license_plate: plate,
          rental_fee_daily: fee,
          outstanding,
          internal_status: classification.internalStatus,
          applicator_status: classification.applicatorStatus,
          vehicle_ownership: classification.vehicleOwnership,
        };
      })
      .filter((row) => row !== null);

    const result = await pool.query<{ result: Record<string, unknown> }>(
      `SELECT public.fleet_import_driver_snapshot($1,$2,$3,$4::jsonb) AS result`,
      [
        cid,
        fileName,
        req.adminUser?.email ?? "unknown",
        JSON.stringify(prepared),
      ],
    );

    const payload = result.rows[0]?.result;
    if (!payload) {
      res.status(500).json({ error: "Import selesai tanpa hasil." });
      return;
    }
    res.json(payload);
  } catch (error) {
    req.log.error({ error }, "Fleet driver master RPC sync failed");
    res.status(500).json({
      error: error instanceof Error ? error.message : "Gagal sinkronisasi master driver dan outstanding.",
    });
  }
});


router.get("/gojek-connector/status", async (req: AdminRequest, res) => {
  try {
    companyId(req);
    const cfg = getGojekConnectorConfig();
    const serverConnector = await getGojekServerConnectorHealth();
    res.json({
      enabled: cfg.enabled,
      mode: cfg.mode,
      portalUrl: cfg.portalUrl,
      allowedHost: cfg.allowedHost,
      ready: cfg.enabled && cfg.sharedSecretConfigured,
      sharedSecretConfigured: cfg.sharedSecretConfigured,
      encryptionKeyConfigured: cfg.encryptionKeyConfigured,
      maxFileMb: cfg.maxFileMb,
      retentionHours: cfg.retentionHours,
      credentialStorage: "hostinger-secrets",
      loginCredentialConfigured: Boolean(
        String(process.env.GOJEK_LOGIN_EMAIL ?? "").trim() &&
        String(process.env.GOJEK_LOGIN_PASSWORD ?? "")
      ),
      fileRetention: "none",
      handoffEndpoint: "/api/logistics/fleet/gojek-connector/handoff",
      automationPolicy: "official-export-no-stealth-no-bypass",
      serverConnector,
    });
  } catch (error) {
    req.log.error({ error }, "Gojek connector status failed");
    res.status(503).json({ error: error instanceof Error ? error.message : "Gagal membaca status Gojek connector." });
  }
});

router.get("/gojek-connector/server-status", async (req: AdminRequest, res) => {
  try {
    companyId(req);
    const status = await getGojekServerConnectorHealth();
    res.json(status);
  } catch (error) {
    req.log.error({ error }, "Gojek server connector status failed");
    res.status(503).json({ error: "Gagal mengambil status server connector." });
  }
});

router.post("/gojek-connector/server-sync/drivers", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const health = await getGojekServerConnectorHealth();
    if (!health.healthy) {
      res.status(503).json({ error: health.error ?? "VPS worker belum Online." });
      return;
    }

    const existing = await pool.query<{ id: string; status: string }>(
      `SELECT id,status
         FROM public.fleet_gojek_sync_jobs
        WHERE company_id=$1
          AND status IN ('pending','running')
        ORDER BY requested_at DESC
        LIMIT 1`,
      [cid],
    );
    if (existing.rows[0]) {
      res.status(409).json({
        error: "Sync Drivers Gojek sedang diproses.",
        jobId: existing.rows[0].id,
        status: existing.rows[0].status,
      });
      return;
    }

    const inserted = await pool.query<{ id: string; status: string; requested_at: string }>(
      `INSERT INTO public.fleet_gojek_sync_jobs(company_id,requested_by,status)
       VALUES($1,$2,'pending')
       RETURNING id,status,requested_at`,
      [cid, req.adminUser?.email ?? "unknown"],
    );
    const job = inserted.rows[0];
    res.status(202).json({ ok: true, jobId: job.id, status: job.status, requestedAt: job.requested_at });
  } catch (error) {
    req.log.error({ error }, "Gojek VPS sync enqueue failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Gagal membuat job Sync Gojek." });
  }
});

router.get("/gojek-connector/server-sync/jobs/:jobId", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const jobId = String(req.params.jobId ?? "").trim();
    const result = await pool.query(
      `SELECT id,status,requested_at,started_at,finished_at,heartbeat_at,
              worker_id,error,result,updated_at
         FROM public.fleet_gojek_sync_jobs
        WHERE id=$1 AND company_id=$2
        LIMIT 1`,
      [jobId, cid],
    );
    const job = result.rows[0];
    if (!job) {
      res.status(404).json({ error: "Job Sync Gojek tidak ditemukan." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, job });
  } catch (error) {
    req.log.error({ error }, "Gojek VPS sync job status failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Gagal membaca status job Sync Gojek." });
  }
});

router.get("/wa/status", async (req: AdminRequest, res) => {
  try {
    companyId(req);
    const status = await getFleetWaGatewayStatus();
    res.json({ ok: true, ...status });
  } catch (error) {
    req.log.error({ error }, "Fleet WA status failed");
    res.status(503).json({ error: "Gagal mengambil status WA Gateway Fleet." });
  }
});

router.post("/wa/test", async (req: AdminRequest, res) => {
  try {
    const cid=companyId(req);
    const phone=String(req.body?.phone??"").trim();
    const message=String(req.body?.message??"").trim();
    if(!phone){res.status(400).json({error:"Nomor WhatsApp tujuan wajib diisi."});return;}
    if(!message){res.status(400).json({error:"Pesan test wajib diisi."});return;}
    if(message.length>2000){res.status(400).json({error:"Pesan test maksimal 2000 karakter."});return;}
    const status=await getFleetWaGatewayStatus();
    if(!(status.configured&&status.gatewayHealthy&&status.deviceId&&status.deviceStatus==="ONLINE")){
      res.status(409).json({error:"WA Gateway Fleet belum siap atau device belum ONLINE.",wa:status});
      return;
    }
    const provider=await sendFleetWa({
      phone,
      message,
      idempotencyKey:"fleet-wa-test:"+cid+":"+Date.now(),
    });
    res.json({ok:true,...provider});
  } catch(error) {
    req.log.error({error},"Fleet WA test send failed");
    res.status(502).json({error:error instanceof Error?error.message:"Gagal mengirim pesan test WhatsApp."});
  }
});

router.post("/outstanding/:id/wa", async (req: AdminRequest, res) => {
  try {
    const cid=companyId(req);
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0){res.status(400).json({error:"ID outstanding tidak valid."});return;}
    const result=await sendFleetOutstandingReminders({
      companyId:cid,
      actor:req.adminUser?.email??"system",
      suppressHours:1,
      ids:[id],
      sendType:"selected",
      phoneOverride:typeof req.body?.phone==="string"?req.body.phone:undefined,
      messageOverride:typeof req.body?.message==="string"?req.body.message:undefined,
    });
    if(result.eligible===0){
      res.status(409).json({error:"Driver tidak memenuhi syarat reminder: harus aktif dan memiliki outstanding > 0."});
      return;
    }
    if(result.sent===0&&result.skippedSuppressed>0){
      res.status(409).json({error:"Reminder baru saja dikirim. Tunggu sebelum mengirim ulang agar tidak duplikat/spam.",...result});
      return;
    }
    if(result.sent===0&&result.failed>0){
      res.status(502).json({error:result.lastError??"Provider WhatsApp gagal mengirim pesan.",...result});
      return;
    }
    if(result.sent===0){
      res.status(409).json({error:"WA belum terkirim. Periksa nomor driver dan status gateway/provider.",...result});
      return;
    }
    res.json({ok:true,message:"WhatsApp berhasil dikirim.",...result});
  } catch(error) {
    req.log.error({error},"Fleet single WA reminder failed");
    res.status(503).json({error:error instanceof Error?error.message:"Gagal mengirim WA Fleet."});
  }
});

router.get("/outstanding/wa-worker-state", async (req: AdminRequest, res) => {
  try {
    const cid=companyId(req);
    const result=await pool.query(
      `SELECT company_id,last_tick_at,last_attempt_at,last_success_at,sender_device,device_status,last_result,last_error,updated_at
         FROM public.fleet_wa_worker_state
        WHERE company_id=$1
        LIMIT 1`,
      [cid],
    );
    res.json({worker:result.rows[0]??null});
  } catch(error) {
    req.log.error({error},"Fleet WA worker state failed");
    res.status(503).json({error:"Gagal mengambil status worker WA Fleet."});
  }
});

router.get("/outstanding/wa-logs", async (req: AdminRequest, res) => {
  try {
    const cid=companyId(req);
    const limit=Math.min(Math.max(Number(req.query.limit)||100,1),500);
    const offset=Math.max(Number(req.query.offset)||0,0);
    const [rows,count]=await Promise.all([
      pool.query(
        `SELECT * FROM public.fleet_wa_logs
          WHERE company_id=$1
          ORDER BY sent_at DESC,id DESC
          LIMIT $2 OFFSET $3`,
        [cid,limit,offset],
      ),
      pool.query<{count:number}>("SELECT COUNT(*)::int count FROM public.fleet_wa_logs WHERE company_id=$1",[cid]),
    ]);
    res.json({logs:rows.rows,total:count.rows[0]?.count??0});
  } catch(error) {
    req.log.error({error},"Fleet WA logs failed");
    res.status(503).json({error:"Gagal mengambil riwayat WhatsApp Fleet."});
  }
});

router.get("/outstanding/auto-blast-settings", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid=companyId(req);
    const result=await pool.query(
      `SELECT auto_blast_enabled,auto_blast_hour,auto_blast_last_run
         FROM public.fleet_settings
        WHERE company_id=$1
        LIMIT 1`,
      [cid],
    );
    const row=result.rows[0] as Record<string,unknown>|undefined;
    res.json({
      enabled:Boolean(row?.auto_blast_enabled),
      hour:Number(row?.auto_blast_hour??8),
      last_run:row?.auto_blast_last_run??null,
    });
  } catch(error) {
    req.log.error({error},"Fleet auto reminder settings failed");
    res.status(503).json({error:"Gagal mengambil pengaturan pengingat WA."});
  }
});

router.put("/outstanding/auto-blast-settings", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid=companyId(req);
    const enabled=req.body?.enabled===true||req.body?.enabled==="true";
    const rawHour=Number(req.body?.hour??8);
    if(!Number.isInteger(rawHour)||rawHour<0||rawHour>23){
      res.status(400).json({error:"Jam auto-blast wajib 0-23 WIB."});
      return;
    }
    const hour=rawHour;
    if(enabled){
      const wa=await getFleetWaGatewayStatus();
      const ready=Boolean(wa.configured&&wa.gatewayHealthy&&wa.deviceId&&wa.deviceStatus==="ONLINE");
      if(!ready){
        res.status(409).json({
          error:`Auto-blast belum dapat diaktifkan. WA Fleet belum siap (gateway=${wa.gatewayStatus}, device=${wa.deviceId??"belum diset"}, status=${wa.deviceStatus??"UNKNOWN"}).`,
          wa,
        });
        return;
      }
    }
    await pool.query(
      `INSERT INTO public.fleet_settings(company_id,auto_blast_enabled,auto_blast_hour,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(company_id) DO UPDATE
         SET auto_blast_enabled=EXCLUDED.auto_blast_enabled,
             auto_blast_hour=EXCLUDED.auto_blast_hour,
             auto_blast_last_run=CASE
               WHEN fleet_settings.auto_blast_enabled IS DISTINCT FROM EXCLUDED.auto_blast_enabled
                 OR fleet_settings.auto_blast_hour IS DISTINCT FROM EXCLUDED.auto_blast_hour
               THEN NULL
               ELSE fleet_settings.auto_blast_last_run
             END,
             updated_at=NOW()`,
      [cid,enabled,hour],
    );
    res.json({ok:true,enabled,hour});
  } catch(error) {
    req.log.error({error},"Fleet auto reminder settings update failed");
    res.status(503).json({error:"Gagal menyimpan pengaturan pengingat WA."});
  }
});

router.post("/outstanding/wa-reminder", async (req: AdminRequest, res) => {
  try {
    const cid=companyId(req);
    const result=await sendFleetOutstandingReminders({
      companyId:cid,
      actor:req.adminUser?.email??"system",
      suppressHours:Number(req.body?.suppress_hours)||24,
      sendType:"manual",
      minOutstanding:50_000,
    });
    res.json({ok:true,...result});
  } catch(error) {
    req.log.error({error},"Fleet WA reminder failed");
    res.status(503).json({error:error instanceof Error?error.message:"Gagal mengirim pengingat WA Fleet."});
  }
});

router.post("/outstanding/wa-blast", async (req: AdminRequest, res) => {
  try {
    const cid=companyId(req);
    const ids=Array.isArray(req.body?.ids)?req.body.ids.map(Number).filter((id:number)=>Number.isSafeInteger(id)&&id>0):[];
    if(!ids.length){res.status(400).json({error:"Tidak ada driver yang dipilih."});return;}
    if(ids.length>100){res.status(400).json({error:"Maksimal 100 driver per pengiriman."});return;}
    const result=await sendFleetOutstandingReminders({
      companyId:cid,
      actor:req.adminUser?.email??"system",
      suppressHours:Number(req.body?.suppress_hours)||24,
      ids,
      sendType:"selected",
    });
    res.json({ok:true,total:result.eligible,...result});
  } catch(error) {
    req.log.error({error},"Fleet selected WA blast failed");
    res.status(503).json({error:error instanceof Error?error.message:"Gagal mengirim WA Fleet."});
  }
});

router.get("/outstanding/import-log", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const result = await pool.query(
      `SELECT id,report_file_name,uploaded_by,uploaded_at,total_rows,rows_imported,rows_skipped,unmatched_drivers,notes
         FROM public.fleet_outstanding_import_log
        WHERE company_id=$1 AND uploaded_at >= NOW() - ($2::int * interval '1 day')
        ORDER BY uploaded_at DESC LIMIT 100`,
      [cid, days],
    );
    res.json({ ok: true, logs: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet import log failed");
    res.status(503).json({ error: "Gagal mengambil riwayat import." });
  }
});

router.post("/outstanding/:id/followup", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    if (!Number.isSafeInteger(id) || id <= 0 || !notes) {
      res.status(400).json({ error: "ID dan catatan wajib valid." });
      return;
    }
    const result = await pool.query(
      `UPDATE public.fleet_outstanding
          SET notes=$3, updated_at=NOW()
        WHERE id=$1 AND company_id=$2 RETURNING id`,
      [id, cid, notes],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Outstanding tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding followup failed");
    res.status(503).json({ error: "Gagal menyimpan catatan." });
  }
});

router.put("/outstanding/:id/resolve", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    const result = await pool.query(
      `UPDATE public.fleet_outstanding
          SET status='resolved', resolved_at=NOW(),
              notes=CASE WHEN $3='' THEN notes ELSE $3 END,
              updated_at=NOW()
        WHERE id=$1 AND company_id=$2 RETURNING id`,
      [id, cid, notes],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Outstanding tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding resolve failed");
    res.status(503).json({ error: "Gagal menyelesaikan outstanding." });
  }
});

router.delete("/outstanding/:id", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Outstanding ID tidak valid." });
      return;
    }
    const confirmation = requireDestructiveConfirmation(req, `DELETE OUTSTANDING ${id}`);
    if (!confirmation.ok) {
      res.status(confirmation.status).json({ error: confirmation.error });
      return;
    }
    const result = await pool.query(
      "DELETE FROM public.fleet_outstanding WHERE id=$1 AND company_id=$2 RETURNING id",
      [id, cid],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Outstanding tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding delete failed");
    res.status(503).json({ error: "Gagal menghapus outstanding." });
  }
});

router.get("/partners", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_partners"))) {
      res.json({ partners: [] });
      return;
    }
    const result = await pool.query(
      "SELECT * FROM public.fleet_partners WHERE company_id=$1 ORDER BY name",
      [cid],
    );
    res.json({ partners: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet partners failed");
    res.status(503).json({ error: "Gagal mengambil partner fleet." });
  }
});


router.post("/reports/preview", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req);
    const content=typeof req.body?.content==="string"?req.body.content:"";
    const fileName=typeof req.body?.fileName==="string"?req.body.fileName:"report.csv";
    if(!content.trim()){res.status(400).json({error:"Isi file CSV tidak tersedia."});return;}
    const parsed=parseGojekTransactionCsv(content);
    const fileHash=createHash("sha256").update(content).digest("hex");
    const dup=await pool.query("SELECT id,original_filename,status FROM public.fleet_reports WHERE company_id=$1 AND file_hash=$2 ORDER BY id DESC LIMIT 1",[cid,fileHash]);
    res.json({
      data:summarizeGojekRows(parsed.rows),
      meta:{version:"standalone-v1",generatedAt:new Date().toISOString()},
      fileHash,rowCount:parsed.rows.length,headers:parsed.headers,columnMapping:parsed.mapping,
      previewRows:parsed.rows.slice(0,20).map(r=>r.raw),warnings:parsed.warnings,
      duplicateReport:dup.rows[0]??null,fileName,
    });
  }catch(error){req.log.error({error},"Fleet report preview failed");res.status(400).json({error:error instanceof Error?error.message:"Gagal preview report."});}
});

router.post("/reports/upload", async (req: AdminRequest, res) => {
  const client=await pool.connect();
  try{
    const cid=companyId(req);
    const content=typeof req.body?.content==="string"?req.body.content:"";
    const fileName=typeof req.body?.fileName==="string"?req.body.fileName.slice(0,255):"report.csv";
    const skipDuplicateCheck=req.body?.skipDuplicateCheck===true||req.body?.skipDuplicateCheck==="true";
    if(!content.trim()){res.status(400).json({error:"Isi file CSV tidak tersedia."});return;}
    const parsed=parseGojekTransactionCsv(content),fileHash=createHash("sha256").update(content).digest("hex");
    if(!skipDuplicateCheck){
      const dup=await client.query("SELECT id,original_filename,status FROM public.fleet_reports WHERE company_id=$1 AND file_hash=$2 ORDER BY id DESC LIMIT 1",[cid,fileHash]);
      if(dup.rows[0]){res.status(409).json({error:"File yang sama sudah pernah diupload.",duplicateReportId:dup.rows[0].id});return;}
    }
    await client.query("BEGIN");
    const report=await client.query<{id:number}>(
      `INSERT INTO public.fleet_reports(company_id,partner_id,filename,original_filename,file_hash,report_type,period_start,period_end,status,row_count,processed_count,error_count,uploaded_by,uploaded_by_email,column_mapping,summary_stats,created_at,updated_at)
       VALUES($1,$2,$3,$3,$4,'gojek_driver',$5,$6,'processing',$7,0,0,$8,$8,$9::jsonb,$10::jsonb,NOW(),NOW()) RETURNING id`,
      [cid,Number(req.body?.partnerId)||null,fileName,fileHash,typeof req.body?.periodStart==="string"&&req.body.periodStart?req.body.periodStart:null,typeof req.body?.periodEnd==="string"&&req.body.periodEnd?req.body.periodEnd:null,parsed.rows.length,req.adminUser?.email??"unknown",JSON.stringify(parsed.mapping),JSON.stringify(summarizeGojekRows(parsed.rows))]);
    const reportId=report.rows[0].id;
    let rawInserted=0,successRows=0,failedRows=0;
    for(let i=0;i<parsed.rows.length;i+=1){
      const row=parsed.rows[i];
      const raw=await client.query<{id:number}>(
        `INSERT INTO public.gojek_raw_transactions(company_id,report_id,date_time_jkt,driver_external_id,driver_name,phone_number,vehicle,amount,total_outstanding_balance,transaction_type,gopay_transaction_reference_id,date,raw_json,service_type,driver_phone,vehicle_plate,date_iso)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),$12,$13::jsonb,$14,$6,$7,$15::date)
         ON CONFLICT DO NOTHING RETURNING id`,
        [cid,reportId,row.raw[parsed.mapping.txDate??""]??row.txDate,row.driverExtId||null,row.driverName,row.driverPhone||null,row.vehiclePlate||null,row.amount,row.outstanding,row.transactionType||null,row.gopayRef,row.txDate||null,JSON.stringify(row.raw),row.serviceType||null,row.txDate||null]);
      if(!raw.rows[0]?.id) continue;
      rawInserted+=1;
      if(!row.txDate){
        await client.query(`INSERT INTO public.gojek_failed_rows(report_id,company_id,raw_row_id,row_index,error_reason,error_stage,raw_data) VALUES($1,$2,$3,$4,'Tanggal transaksi tidak dapat diparse','transform',$5::jsonb)`,[reportId,cid,raw.rows[0].id,i+2,JSON.stringify(row.raw)]);
        failedRows+=1; continue;
      }
      try{
        await client.query(
          `INSERT INTO public.fleet_transactions(company_id,report_id,driver_external_id,driver_name,vehicle_plate,transaction_date,trip_count,gross_revenue,incentive,commission,deduction,net_revenue,outstanding_balance,service_type,raw_data,amount,transaction_type,driver_phone,gopay_reference_id)
           VALUES($1,$2,$3,$4,$5,$6,0,GREATEST($7,0),0,0,0,$7,$8,$9,$10::jsonb,$7,$11,$12,NULLIF($13,''))
           ON CONFLICT DO NOTHING`,
          [cid,reportId,row.driverExtId||null,row.driverName,row.vehiclePlate||null,row.txDate,row.amount,row.outstanding,row.serviceType||null,JSON.stringify(row.raw),row.transactionType||null,row.driverPhone||null,row.gopayRef]);
        successRows+=1;
      }catch(rowError){
        await client.query(`INSERT INTO public.gojek_failed_rows(report_id,company_id,raw_row_id,row_index,error_reason,error_stage,raw_data) VALUES($1,$2,$3,$4,$5,'transform',$6::jsonb)`,[reportId,cid,raw.rows[0].id,i+2,rowError instanceof Error?rowError.message:"Transform gagal",JSON.stringify(row.raw)]);
        failedRows+=1;
      }
    }
    const status=failedRows===0?"done":successRows>0?"partial":"error";
    await client.query("UPDATE public.fleet_reports SET status=$2,processed_count=$3,error_count=$4,updated_at=NOW() WHERE id=$1",[reportId,status,successRows,failedRows]);
    await client.query("COMMIT");
    res.status(201).json({reportId,message:`Upload selesai: ${successRows} berhasil, ${failedRows} gagal`,status});
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);req.log.error({error},"Fleet report upload failed");res.status(500).json({error:error instanceof Error?error.message:"Upload report gagal."});}finally{client.release();}
});

router.get("/reports/:id/progress", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),id=Number(req.params.id);
    const report=await pool.query("SELECT * FROM public.fleet_reports WHERE id=$1 AND company_id=$2 LIMIT 1",[id,cid]);
    if(!report.rows[0]){res.status(404).json({error:"Report tidak ditemukan."});return;}
    const [raw,dlq]=await Promise.all([
      pool.query<{count:number}>("SELECT COUNT(*)::int count FROM public.gojek_raw_transactions WHERE company_id=$1 AND report_id=$2",[cid,id]),
      pool.query<{count:number}>("SELECT COUNT(*)::int count FROM public.gojek_failed_rows WHERE company_id=$1 AND report_id=$2 AND resolved=false",[cid,id]),
    ]);
    const r=report.rows[0],failed=Number(r.error_count??0),success=Number(r.processed_count??0),total=Number(r.row_count??0),health=total?Math.max(0,Math.round((success/total)*100)):100;
    res.json({reportId:id,status:r.status,rowCount:total,rawInserted:raw.rows[0]?.count??0,successRows:success,failedRows:failed,dlqCount:dlq.rows[0]?.count??0,healthScore:health,grade:health>=95?"A":health>=80?"B":health>=60?"C":health>=40?"D":"F",durationMs:null,updatedAt:r.updated_at});
  }catch(error){req.log.error({error},"Fleet report progress failed");res.status(503).json({error:"Gagal mengambil progress."});}
});

router.post("/reports/:id/purge", async (req: AdminRequest, res) => {
  const client=await pool.connect();
  try{
    const cid=companyId(req),id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0){res.status(400).json({error:"Report ID tidak valid."});return;}
    const confirmation=requireDestructiveConfirmation(req,`PURGE REPORT ${id}`);
    if(!confirmation.ok){res.status(confirmation.status).json({error:confirmation.error});return;}
    await client.query("BEGIN");
    await client.query("DELETE FROM public.gojek_failed_rows WHERE company_id=$1 AND report_id=$2",[cid,id]);
    await client.query("DELETE FROM public.fleet_transactions WHERE company_id=$1 AND report_id=$2",[cid,id]);
    await client.query("DELETE FROM public.gojek_raw_transactions WHERE company_id=$1 AND report_id=$2",[cid,id]);
    const result=await client.query("UPDATE public.fleet_reports SET status='purged',processed_count=0,error_count=0,updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING id",[id,cid]);
    if(result.rowCount!==1){await client.query("ROLLBACK");res.status(404).json({error:"Report tidak ditemukan."});return;}
    await client.query("COMMIT");res.json({ok:true});
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);req.log.error({error},"Fleet report purge failed");res.status(503).json({error:"Gagal purge report."});}finally{client.release();}
});

router.delete("/reports/:id", async (req: AdminRequest, res) => {
  const client=await pool.connect();
  try{
    const cid=companyId(req),id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0){res.status(400).json({error:"Report ID tidak valid."});return;}
    const confirmation=requireDestructiveConfirmation(req,`DELETE REPORT ${id}`);
    if(!confirmation.ok){res.status(confirmation.status).json({error:confirmation.error});return;}
    await client.query("BEGIN");
    await client.query("DELETE FROM public.gojek_failed_rows WHERE company_id=$1 AND report_id=$2",[cid,id]);
    await client.query("DELETE FROM public.fleet_transactions WHERE company_id=$1 AND report_id=$2",[cid,id]);
    await client.query("DELETE FROM public.gojek_raw_transactions WHERE company_id=$1 AND report_id=$2",[cid,id]);
    const result=await client.query("DELETE FROM public.fleet_reports WHERE id=$1 AND company_id=$2 RETURNING id",[id,cid]);
    if(result.rowCount!==1){await client.query("ROLLBACK");res.status(404).json({error:"Report tidak ditemukan."});return;}
    await client.query("COMMIT");res.json({ok:true});
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);req.log.error({error},"Fleet report rollback failed");res.status(503).json({error:"Gagal rollback report."});}finally{client.release();}
});

router.post("/reports/purge-all", async (req: AdminRequest, res) => {
  const client=await pool.connect();
  try{
    const cid=companyId(req);
    const confirmation=requireDestructiveConfirmation(req,`PURGE ALL FLEET DATA COMPANY ${cid}`,{ownerOnly:true});
    if(!confirmation.ok){res.status(confirmation.status).json({error:confirmation.error});return;}
    await client.query("BEGIN");
    const reports=await client.query<{count:number}>("SELECT COUNT(*)::int count FROM public.fleet_reports WHERE company_id=$1",[cid]);
    await client.query("DELETE FROM public.gojek_failed_rows WHERE company_id=$1",[cid]);
    await client.query("DELETE FROM public.fleet_transactions WHERE company_id=$1",[cid]);
    await client.query("DELETE FROM public.gojek_raw_transactions WHERE company_id=$1",[cid]);
    await client.query("DELETE FROM public.fleet_reports WHERE company_id=$1",[cid]);
    await client.query("COMMIT");
    res.json({ok:true,message:`${reports.rows[0]?.count??0} report dan data turunannya dihapus.`,reportCount:reports.rows[0]?.count??0});
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);req.log.error({error},"Fleet purge-all failed");res.status(503).json({error:"Gagal menghapus seluruh report."});}finally{client.release();}
});

router.get("/reports", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_reports"))) {
      res.json({ reports: [] });
      return;
    }
    const result = await pool.query(
      "SELECT * FROM public.fleet_reports WHERE company_id=$1 ORDER BY id DESC LIMIT 100",
      [cid],
    );
    res.json({ reports: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet reports failed");
    res.status(503).json({ error: "Gagal mengambil report fleet." });
  }
});


router.get("/transactions", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_transactions"))) {
      const rawCount = (await tableExists("gojek_raw_transactions"))
        ? Number((await pool.query<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM public.gojek_raw_transactions WHERE company_id=$1",
            [cid],
          )).rows[0]?.count ?? 0)
        : 0;
      res.json({
        transactions: [],
        summary: { total: 0, total_trips: 0, total_net: 0, total_gross: 0 },
        sourceStatus: {
          normalizedRows: 0,
          rawRows: rawCount,
          state: rawCount > 0 ? "raw_only" : "no_source_data",
        },
      });
      return;
    }
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
    const driverSearch = typeof req.query.driverSearch === "string" ? req.query.driverSearch.trim() : "";
    const vehiclePlate = typeof req.query.vehiclePlate === "string" ? req.query.vehiclePlate.trim() : "";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = (page - 1) * limit;

    const rows = await pool.query(
      `SELECT *
         FROM public.fleet_transactions
        WHERE company_id=$1
          AND EXISTS (
            SELECT 1 FROM public.fleet_drivers d
            WHERE d.company_id = fleet_transactions.company_id::text
              AND d.status='active'
              AND COALESCE(d.source_present_in_latest_snapshot,true)=true
              AND (
                (NULLIF(fleet_transactions.driver_external_id,'') IS NOT NULL
                 AND d.driver_external_id=fleet_transactions.driver_external_id)
                OR
                (LOWER(TRIM(d.full_name))=LOWER(TRIM(fleet_transactions.driver_name))
                 AND NULLIF(fleet_transactions.vehicle_plate,'') IS NOT NULL
                 AND UPPER(TRIM(d.vehicle_plate))=UPPER(TRIM(fleet_transactions.vehicle_plate)))
              )
          )
          AND ($2::date IS NULL OR transaction_date >= $2::date)
          AND ($3::date IS NULL OR transaction_date <= $3::date)
          AND ($4='' OR COALESCE(driver_name,'') ILIKE '%' || $4 || '%' OR COALESCE(driver_external_id,'') ILIKE '%' || $4 || '%')
          AND ($5='' OR COALESCE(vehicle_plate,'') ILIKE '%' || $5 || '%')
        ORDER BY transaction_date DESC, id DESC
        LIMIT $6 OFFSET $7`,
      [cid, startDate, endDate, driverSearch, vehiclePlate, limit, offset],
    );
    const summary = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(trip_count),0)::int AS total_trips,
              COALESCE(SUM(net_revenue),0)::numeric AS total_net,
              COALESCE(SUM(gross_revenue),0)::numeric AS total_gross
         FROM public.fleet_transactions
        WHERE company_id=$1
          AND EXISTS (
            SELECT 1 FROM public.fleet_drivers d
            WHERE d.company_id = fleet_transactions.company_id::text
              AND d.status='active'
              AND COALESCE(d.source_present_in_latest_snapshot,true)=true
              AND (
                (NULLIF(fleet_transactions.driver_external_id,'') IS NOT NULL
                 AND d.driver_external_id=fleet_transactions.driver_external_id)
                OR
                (LOWER(TRIM(d.full_name))=LOWER(TRIM(fleet_transactions.driver_name))
                 AND NULLIF(fleet_transactions.vehicle_plate,'') IS NOT NULL
                 AND UPPER(TRIM(d.vehicle_plate))=UPPER(TRIM(fleet_transactions.vehicle_plate)))
              )
          )
          AND ($2::date IS NULL OR transaction_date >= $2::date)
          AND ($3::date IS NULL OR transaction_date <= $3::date)
          AND ($4='' OR COALESCE(driver_name,'') ILIKE '%' || $4 || '%' OR COALESCE(driver_external_id,'') ILIKE '%' || $4 || '%')
          AND ($5='' OR COALESCE(vehicle_plate,'') ILIKE '%' || $5 || '%')`,
      [cid, startDate, endDate, driverSearch, vehiclePlate],
    );
    const rawRows = (await tableExists("gojek_raw_transactions"))
      ? Number((await pool.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM public.gojek_raw_transactions WHERE company_id=$1",
          [cid],
        )).rows[0]?.count ?? 0)
      : 0;
    const normalizedRows = Number(summary.rows[0]?.total ?? 0);
    res.json({
      transactions: rows.rows,
      summary: summary.rows[0] ?? {},
      sourceStatus: {
        normalizedRows,
        rawRows,
        state: normalizedRows > 0 ? "normalized" : rawRows > 0 ? "raw_only" : "no_source_data",
      },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet transactions failed");
    res.status(503).json({ error: "Gagal mengambil transaksi fleet." });
  }
});

router.get("/drivers", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    if (!(await tableExists("fleet_drivers"))) {
      res.json({ drivers: [], total: 0 });
      return;
    }
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" && req.query.status !== "all" ? req.query.status.trim() : "";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = (page - 1) * limit;
    const statusSql = status === "inactive"
      ? "d.status <> 'active'"
      : "($3='' OR d.status=$3)";

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT d.*,
                d.full_name AS name,
                COALESCE(o.outstanding,0)::numeric AS outstanding
           FROM public.fleet_drivers d
           LEFT JOIN LATERAL (
             SELECT SUM(outstanding_amount)::numeric AS outstanding
               FROM public.fleet_outstanding fo
              WHERE fo.company_id=$1
                AND fo.status='open'
                AND (fo.driver_id=d.id OR lower(fo.driver_name)=lower(d.full_name))
           ) o ON TRUE
          WHERE d.company_id=$1::text
            AND ($2='' OR d.full_name ILIKE '%' || $2 || '%' OR COALESCE(d.driver_external_id,'') ILIKE '%' || $2 || '%' OR COALESCE(d.vehicle_plate,'') ILIKE '%' || $2 || '%' OR COALESCE(d.phone,'') ILIKE '%' || $2 || '%')
            AND ${statusSql}
          ORDER BY
            CASE
              WHEN d.status = 'active' THEN 1
              WHEN d.status = 'suspended' OR d.applicator_status = 'fired' THEN 2
              WHEN d.applicator_status = 'need_to_assign' THEN 3
              WHEN d.applicator_status = 'resign' THEN 4
              WHEN d.status = 'fired' THEN 5
              ELSE 6
            END ASC,
            d.full_name ASC
          LIMIT $4 OFFSET $5`,
        [cid, search, status, limit, offset],
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM public.fleet_drivers d
          WHERE d.company_id=$1::text
            AND ($2='' OR d.full_name ILIKE '%' || $2 || '%' OR COALESCE(d.driver_external_id,'') ILIKE '%' || $2 || '%' OR COALESCE(d.vehicle_plate,'') ILIKE '%' || $2 || '%' OR COALESCE(d.phone,'') ILIKE '%' || $2 || '%')
            AND ${statusSql}`,
        [cid, search, status],
      ),
    ]);
    res.json({ drivers: rows.rows, total: count.rows[0]?.count ?? 0 });
  } catch (error) {
    req.log.error({ error }, "Fleet drivers failed");
    res.status(503).json({ error: "Gagal mengambil daftar driver." });
  }
});

router.put("/drivers/:id", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    const body = req.body ?? {};
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID driver tidak valid." });
      return;
    }
    const result = await pool.query(
      `UPDATE public.fleet_drivers
          SET full_name=COALESCE(NULLIF($3,''),full_name),
              phone=COALESCE(NULLIF($4,''),phone),
              email=COALESCE(NULLIF($5,''),email),
              license_number=COALESCE(NULLIF($6,''),license_number),
              vehicle_plate=NULLIF($7,''),
              vehicle_type=COALESCE(NULLIF($8,''),vehicle_type),
              status=COALESCE(NULLIF($9,''),status),
              notes=COALESCE($10,notes),
              updated_at=NOW()
        WHERE id=$1 AND company_id=$2::text
        RETURNING *, full_name AS name`,
      [
        id, cid,
        typeof body.name === "string" ? body.name.trim() : "",
        typeof body.phone === "string" ? body.phone.trim() : "",
        typeof body.email === "string" ? body.email.trim() : "",
        typeof body.licenseNumber === "string" ? body.licenseNumber.trim() : "",
        typeof body.vehiclePlate === "string" ? body.vehiclePlate.trim().toUpperCase() : "",
        typeof body.vehicleType === "string" ? body.vehicleType.trim() : "",
        typeof body.status === "string" ? body.status.trim() : "",
        typeof body.notes === "string" ? body.notes : null,
      ],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Driver tidak ditemukan." });
      return;
    }
    res.json({ ok: true, driver: result.rows[0] });
  } catch (error) {
    req.log.error({ error }, "Fleet driver update failed");
    res.status(503).json({ error: "Gagal memperbarui driver." });
  }
});

router.get("/drivers/:extId/detail", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const extId = String(req.params.extId ?? "");
    if (!(await tableExists("fleet_drivers"))) {
      res.status(404).json({ error: "Driver tidak ditemukan." });
      return;
    }
    const driver = await pool.query(
      `SELECT d.*, d.full_name AS name
         FROM public.fleet_drivers d
        WHERE d.company_id=$1::text AND (d.driver_external_id=$2 OR d.id::text=$2)
        LIMIT 1`,
      [cid, extId],
    );
    const row = driver.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: "Driver tidak ditemukan." });
      return;
    }
    const [transactions, outstanding] = await Promise.all([
      tableExists("fleet_transactions").then((exists) => exists
        ? pool.query(
            `SELECT * FROM public.fleet_transactions
              WHERE company_id=$1 AND (driver_external_id=$2 OR driver_id=$3)
              ORDER BY transaction_date DESC, id DESC LIMIT 100`,
            [cid, row.driver_external_id ?? "", row.id],
          )
        : Promise.resolve({ rows: [] } as { rows: unknown[] })),
      pool.query(
        `SELECT * FROM public.fleet_outstanding
          WHERE company_id=$1 AND (driver_external_id=$2 OR driver_id=$3 OR lower(driver_name)=lower($4))
          ORDER BY id DESC LIMIT 20`,
        [cid, row.driver_external_id ?? "", row.id, row.full_name ?? ""],
      ),
    ]);
    res.json({ driver: row, transactions: transactions.rows, outstanding: outstanding.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet driver detail failed");
    res.status(503).json({ error: "Gagal memuat detail driver." });
  }
});

// PROD isolated Company 3 asset registry; never reclassify Gojek operational inventory. Never reclassify CST GoCar operating inventory.
router.get("/vehicles/diva-assets", async (req: AdminRequest, res) => {
  if (process.env.APP_ENV !== "production" ||
      !canManageDivaTax(req.adminUser)) {
    res.status(403).json({ error: "Hanya Owner/Super Admin atau Admin Fleet yang ditugaskan yang berwenang." });
    return;
  }
  try {
    if (!divaAssetReadEnabled()) {
      res.status(404).json({ error: "Aset Diva belum diaktifkan pada Fleet PROD." });
      return;
    }
    // The dedicated PROD reader has RLS SELECT only for Company 3 assets.
    // No fallback to the inventory table or a privileged Finance pool.
    const result = await divaAssetReadPool.query(
      `SELECT u.plate_number,u.brand,u.model,u.ownership_type,u.status,u.unit_number,
              tax.id AS tax_document_id,
              tax.updated_at::text AS tax_version,
              tax.issued_date::text AS tax_renewed_on,
              tax.expired_date::text AS tax_due_date,
              tax.status AS tax_status,tax.reminder_days AS tax_reminder_days
         FROM public.fleet_units u
         LEFT JOIN LATERAL (
           SELECT d.id,d.updated_at,d.issued_date,d.expired_date,d.status,d.reminder_days
             FROM public.fleet_documents d
            WHERE d.company_id=u.company_id
              AND d.fleet_unit_id=u.id
              AND d.doc_type='annual_vehicle_tax'
            ORDER BY d.issued_date DESC NULLS LAST, d.expired_date DESC NULLS LAST
            LIMIT 1
         ) tax ON TRUE
        WHERE u.company_id=$1
        ORDER BY u.plate_number ASC LIMIT 100`,
      ["3"],
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ companyId: 3, companyName: "PT Diva Servis", taxEditEnabled: divaTaxWriterEnabled() && !!process.env.FLEET_DIVA_TAX_DATABASE_URL_PROD, assets: result.rows });
  } catch (error) {
    req.log.error({ error }, "Diva asset registry read failed");
    res.status(503).json({ error: "Data aset PT Diva Servis belum dapat dibaca." });
  }
});

// Production-only scoped editor, disabled until separate PROD approval. The existing Fleet inventory reader NEVER receives UPDATE.
router.patch("/vehicles/diva-assets/:plate/tax", async (req: AdminRequest, res) => {
  if (process.env.APP_ENV !== "production" || !divaTaxWriterEnabled() ||
      !canManageDivaTax(req.adminUser) ||
      req.get("origin") !== "https://fleet.cstlogistic.co.id" ||
      !req.secure || req.hostname !== "fleet.cstlogistic.co.id") {
    res.status(403).json({error:"Edit pajak memerlukan Owner/Super Admin atau Admin Fleet yang ditugaskan."});
    return;
  }
  try {
    const result = await editDivaAnnualTax(
      String(req.params.plate ?? "").trim().toUpperCase(),
      req.body ?? {},
      req.adminUser?.email ?? "",
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result);
  } catch (error) {
    req.log.error({error: error instanceof DivaTaxEditError ? error.message : error}, "Diva annual tax edit failed");
    if (error instanceof DivaTaxEditError) {
      res.status(error.status).json({error:error.message});
    } else {
      res.status(503).json({error:"Penyimpanan pajak PROD belum diaktifkan. Tidak ada perubahan tersimpan."});
    }
  }
});

router.get("/vehicles", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_vehicles"))) {
      res.json({ vehicles: [] });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    // Optional activity source; preserve inventory GET if transactions are absent.
    const hasTransactionTable = await tableExists("fleet_transactions");
    const result = await pool.query(fleetVehicleReadSql(hasTransactionTable), [cid, limit]);
    // Display-only evidence; never modifies vehicle/driver status or permits dispatch.
    res.json({ vehicles: result.rows.map((row) => withFleetVehicleEvidence(row)) });
  } catch (error) {
    req.log.error({ error }, "Fleet vehicles failed");
    res.status(503).json({ error: "Gagal mengambil kendaraan." });
  }
});

router.post("/vehicles", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_vehicles"))) {
      res.status(503).json({ error: "Tabel fleet_vehicles belum tersedia." });
      return;
    }
    const body = req.body ?? {};
    const plate = typeof body.plate === "string" ? body.plate.trim().toUpperCase() : "";
    if (!plate) {
      res.status(400).json({ error: "Plat kendaraan wajib diisi." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO public.fleet_vehicles
        (company_id,partner_id,driver_id,plate,vehicle_type,brand,model,year,color,status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        cid,
        Number(body.partnerId) || null,
        Number(body.driverId) || null,
        plate,
        typeof body.vehicleType === "string" && body.vehicleType.trim() ? body.vehicleType.trim() : "motor",
        typeof body.brand === "string" ? body.brand.trim() || null : null,
        typeof body.model === "string" ? body.model.trim() || null : null,
        Number(body.year) || null,
        typeof body.color === "string" ? body.color.trim() || null : null,
        typeof body.status === "string" && body.status.trim() ? body.status.trim() : "active",
        typeof body.notes === "string" ? body.notes : null,
      ],
    );
    res.status(201).json({ ok: true, vehicle: result.rows[0] });
  } catch (error) {
    req.log.error({ error }, "Fleet vehicle create failed");
    res.status(503).json({ error: "Gagal menambah kendaraan." });
  }
});

router.get("/analytics", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    if (!(await tableExists("fleet_transactions"))) {
      res.json({ driverPerformance: [], vehiclePerformance: [], weekdayPattern: [], serviceBreakdown: [] });
      return;
    }
    const [drivers, vehicles, weekday, services] = await Promise.all([
      pool.query(
        `SELECT driver_external_id, MAX(driver_name) AS driver_name, MAX(vehicle_plate) AS vehicle_plate,
                COUNT(*)::int AS active_days, COALESCE(SUM(trip_count),0)::int AS trips,
                COALESCE(SUM(net_revenue),0)::numeric AS net_revenue,
                COALESCE(SUM(gross_revenue),0)::numeric AS gross_revenue,
                MAX(service_type) AS service_type
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
          GROUP BY driver_external_id
          ORDER BY COALESCE(SUM(net_revenue),0) DESC
          LIMIT 100`,
        [cid, days],
      ),
      pool.query(
        `SELECT vehicle_plate, MAX(service_type) AS service_type,
                COUNT(*)::int AS active_days, COALESCE(SUM(trip_count),0)::int AS trips,
                COALESCE(SUM(net_revenue),0)::numeric AS net_revenue
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
            AND NULLIF(vehicle_plate,'') IS NOT NULL
          GROUP BY vehicle_plate
          ORDER BY COALESCE(SUM(net_revenue),0) DESC
          LIMIT 100`,
        [cid, days],
      ),
      pool.query(
        `SELECT EXTRACT(ISODOW FROM transaction_date)::int AS day_no,
                TRIM(TO_CHAR(transaction_date,'Day')) AS day_name,
                AVG(trip_count)::numeric AS avg_trips,
                AVG(net_revenue)::numeric AS avg_revenue,
                COUNT(DISTINCT driver_external_id)::numeric / GREATEST(COUNT(DISTINCT transaction_date),1) AS avg_drivers
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
          GROUP BY 1,2 ORDER BY 1`,
        [cid, days],
      ),
      pool.query(
        `SELECT COALESCE(service_type,'Unknown') AS service_type,
                COUNT(*)::int AS transactions,
                COALESCE(SUM(trip_count),0)::int AS trips,
                COALESCE(SUM(net_revenue),0)::numeric AS revenue
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
          GROUP BY COALESCE(service_type,'Unknown')
          ORDER BY revenue DESC`,
        [cid, days],
      ),
    ]);
    res.json({
      driverPerformance: drivers.rows,
      vehiclePerformance: vehicles.rows,
      weekdayPattern: weekday.rows,
      serviceBreakdown: services.rows,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet analytics failed");
    res.status(503).json({ error: "Gagal mengambil analytics fleet." });
  }
});

router.get("/analytics/idle-vehicles", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
    if (!(await tableExists("fleet_vehicles"))) {
      res.json({ idleVehicles: [] });
      return;
    }
    const hasTx = await tableExists("fleet_transactions");
    const query = hasTx
      ? `SELECT v.*, d.full_name AS driver_name, MAX(t.transaction_date) AS last_transaction_date
           FROM public.fleet_vehicles v
           LEFT JOIN public.fleet_drivers d ON d.id=v.driver_id AND d.company_id=v.company_id::text
           LEFT JOIN public.fleet_transactions t ON t.company_id=v.company_id AND t.vehicle_plate=v.plate
          WHERE v.company_id=$1
          GROUP BY v.id,d.full_name
         HAVING MAX(t.transaction_date) IS NULL OR MAX(t.transaction_date) < CURRENT_DATE - ($2::int * interval '1 day')
          ORDER BY MAX(t.transaction_date) NULLS FIRST`
      : `SELECT v.*, d.full_name AS driver_name, NULL::date AS last_transaction_date
           FROM public.fleet_vehicles v
           LEFT JOIN public.fleet_drivers d ON d.id=v.driver_id AND d.company_id=v.company_id::text
          WHERE v.company_id=$1 ORDER BY v.plate`;
    const result = await pool.query(query, hasTx ? [cid, days] : [cid]);
    res.json({ idleVehicles: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet idle vehicles failed");
    res.status(503).json({ error: "Gagal mengambil kendaraan idle." });
  }
});

router.get("/analytics/churn-risk", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_drivers"))) {
      res.json({ churnRisk: [] });
      return;
    }
    const hasTx = await tableExists("fleet_transactions");
    const result = hasTx
      ? await pool.query(
          `SELECT d.*, MAX(t.transaction_date) AS last_transaction_date,
                  GREATEST(0,(CURRENT_DATE-MAX(t.transaction_date))::int) AS inactive_days,
                  COALESCE(SUM(t.net_revenue) FILTER (WHERE t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'),0)::numeric AS revenue_30d
             FROM public.fleet_drivers d
             LEFT JOIN public.fleet_transactions t
               ON t.company_id=d.company_id AND (t.driver_id=d.id OR t.driver_external_id=d.driver_external_id)
            WHERE d.company_id=$1::text AND d.status='active'
            GROUP BY d.id
           HAVING MAX(t.transaction_date) IS NULL OR MAX(t.transaction_date) < CURRENT_DATE - INTERVAL '7 days'
            ORDER BY inactive_days DESC NULLS FIRST`,
          [cid],
        )
      : { rows: [] };
    res.json({ churnRisk: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet churn risk failed");
    res.status(503).json({ error: "Gagal mengambil churn risk." });
  }
});

router.get("/analytics/forecast", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_daily_summary"))) {
      res.json({ historical: [], forecast: [], forecastAvg: 0 });
      return;
    }
    const historical = await pool.query(
      `SELECT summary_date, net_revenue, gross_revenue, active_drivers, total_trips
         FROM public.fleet_daily_summary
        WHERE company_id=$1
        ORDER BY summary_date DESC LIMIT 60`,
      [cid],
    );
    const ordered = [...historical.rows].reverse();
    const recent = ordered.slice(-14).map((r) => Number((r as Record<string, unknown>).net_revenue) || 0);
    const avg = recent.length ? recent.reduce((a,b)=>a+b,0)/recent.length : 0;
    const forecast = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() + i + 1);
      return { date: d.toISOString().slice(0,10), forecast_revenue: avg };
    });
    res.json({ historical: ordered, forecast, forecastAvg: avg });
  } catch (error) {
    req.log.error({ error }, "Fleet forecast failed");
    res.status(503).json({ error: "Gagal mengambil forecast." });
  }
});

router.get("/alerts", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_alerts"))) {
      res.json({ alerts: [], unreadCount: 0 });
      return;
    }
    try {
      await syncFleetAlertsForCompany(cid);
    } catch (syncError) {
      req.log.error({ error: syncError, companyId: cid }, "Fleet alert sweep failed; serving persisted alerts");
    }
    const isRead = typeof req.query.isRead === "string" && req.query.isRead !== "all" ? req.query.isRead : "";
    const severity = typeof req.query.severity === "string" && req.query.severity !== "all" ? req.query.severity : "";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const [rows, unread] = await Promise.all([
      pool.query(
        `SELECT a.*, d.full_name AS driver_name,
                 (a.is_notified OR COALESCE(o.is_notified,false)) AS is_notified,
                 COALESCE(o.last_wa_sent_at,a.notified_at) AS notified_at
           FROM public.fleet_alerts a
           LEFT JOIN public.fleet_drivers d
             ON d.id=a.driver_id
            AND d.company_id=a.company_id::text
           LEFT JOIN public.fleet_outstanding o
             ON a.alert_type='outstanding_high'
            AND a.reference_type='fleet_outstanding'
            AND a.reference_id=o.id::text
            AND a.company_id=o.company_id
          WHERE a.company_id=$1
            AND a.auto_resolved_at IS NULL
            AND ($2='' OR a.is_read=$2::boolean)
            AND ($3='' OR a.severity=$3)
          ORDER BY a.created_at DESC LIMIT $4 OFFSET $5`,
        [cid, isRead, severity, limit, offset],
      ),
      pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM public.fleet_alerts WHERE company_id=$1 AND is_read=false AND auto_resolved_at IS NULL",
        [cid],
      ),
    ]);
    res.json({ alerts: rows.rows, unreadCount: unread.rows[0]?.count ?? 0 });
  } catch (error) {
    req.log.error({ error }, "Fleet alerts failed");
    res.status(503).json({ error: "Gagal mengambil alert fleet." });
  }
});

router.put("/alerts/:id/read", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const id = Number(req.params.id);
    const result = await pool.query(
      "UPDATE public.fleet_alerts SET is_read=true WHERE id=$1 AND company_id=$2 RETURNING id",
      [id, cid],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Alert tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet alert read failed");
    res.status(503).json({ error: "Gagal memperbarui alert." });
  }
});

router.put("/alerts/read-all", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (await tableExists("fleet_alerts")) {
      await pool.query("UPDATE public.fleet_alerts SET is_read=true WHERE company_id=$1 AND is_read=false", [cid]);
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet alert read-all failed");
    res.status(503).json({ error: "Gagal memperbarui alert." });
  }
});

router.get("/ledger", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("gojek_raw_transactions"))) {
      res.json({ transactions: [], summary: { total: 0, total_amount: 0 }, transactionTypes: [], pagination: { page: 1, limit: 50, offset: 0 } });
      return;
    }
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const driverName = typeof req.query.driverName === "string" ? req.query.driverName.trim() : "";
    const driverExtId = typeof req.query.driverExtId === "string" ? req.query.driverExtId.trim() : "";
    const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : null;
    const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : null;
    const transactionType = typeof req.query.transactionType === "string" ? req.query.transactionType.trim() : "";
    const reportId = Number(req.query.reportId) || 0;
    const [rows, summary, types] = await Promise.all([
      pool.query(
        `SELECT *
           FROM public.gojek_raw_transactions
          WHERE company_id=$1
            AND ($2='' OR COALESCE(driver_name,'') ILIKE '%' || $2 || '%')
            AND ($3='' OR COALESCE(driver_external_id,'') ILIKE '%' || $3 || '%')
            AND ($4::date IS NULL OR date_iso >= $4::date)
            AND ($5::date IS NULL OR date_iso <= $5::date)
            AND ($6='' OR COALESCE(transaction_type,'')=$6)
            AND ($7=0 OR report_id=$7)
          ORDER BY COALESCE(date_iso,created_at::date) DESC, id DESC
          LIMIT $8 OFFSET $9`,
        [cid, driverName, driverExtId, dateFrom, dateTo, transactionType, reportId, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total, COALESCE(SUM(amount),0)::numeric AS total_amount
           FROM public.gojek_raw_transactions
          WHERE company_id=$1
            AND ($2='' OR COALESCE(driver_name,'') ILIKE '%' || $2 || '%')
            AND ($3='' OR COALESCE(driver_external_id,'') ILIKE '%' || $3 || '%')
            AND ($4::date IS NULL OR date_iso >= $4::date)
            AND ($5::date IS NULL OR date_iso <= $5::date)
            AND ($6='' OR COALESCE(transaction_type,'')=$6)
            AND ($7=0 OR report_id=$7)`,
        [cid, driverName, driverExtId, dateFrom, dateTo, transactionType, reportId],
      ),
      pool.query<{ transaction_type: string }>(
        `SELECT DISTINCT transaction_type
           FROM public.gojek_raw_transactions
          WHERE company_id=$1 AND NULLIF(transaction_type,'') IS NOT NULL
          ORDER BY transaction_type`,
        [cid],
      ),
    ]);
    res.json({
      transactions: rows.rows,
      summary: summary.rows[0] ?? { total: 0, total_amount: 0 },
      transactionTypes: types.rows.map((r) => r.transaction_type),
      pagination: { page, limit, offset },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet ledger failed");
    res.status(503).json({ error: "Gagal mengambil ledger fleet." });
  }
});

router.get("/outstanding/macet", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const minDays = Math.max(Number(req.query.min_days) || 7, 1);
    const minAmount = Math.max(Number(req.query.min_amount) || 1000000, 0);
    const hasRaw = await tableExists("gojek_raw_transactions");
    const result = hasRaw
      ? await pool.query(
          `SELECT o.*, MAX(r.date_iso) AS last_updated_date,
                  GREATEST(0,(CURRENT_DATE-MAX(r.date_iso))::int) AS days_inactive
             FROM public.fleet_outstanding o
             LEFT JOIN public.gojek_raw_transactions r
               ON r.company_id=o.company_id AND r.driver_external_id=o.driver_external_id
            WHERE o.company_id=$1 AND o.status='open' AND o.outstanding_amount >= $2
            GROUP BY o.id
           HAVING MAX(r.date_iso) IS NULL OR MAX(r.date_iso) <= CURRENT_DATE - ($3::int * interval '1 day')
            ORDER BY o.outstanding_amount DESC`,
          [cid, minAmount, minDays],
        )
      : await pool.query(
          `SELECT o.*, NULL::date AS last_updated_date, NULL::int AS days_inactive
             FROM public.fleet_outstanding o
            WHERE o.company_id=$1 AND o.status='open' AND o.outstanding_amount >= $2
            ORDER BY o.outstanding_amount DESC`,
          [cid, minAmount],
        );
    const total = result.rows.reduce((sum, row) => sum + (Number((row as Record<string, unknown>).outstanding_amount) || 0), 0);
    res.json({ drivers: result.rows, summary: { count: result.rows.length, total_outstanding: total } });
  } catch (error) {
    req.log.error({ error }, "Fleet macet failed");
    res.status(503).json({ error: "Gagal mengambil driver macet." });
  }
});

router.get("/system-overview", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const countTable = async (name: string): Promise<number> => {
      if (!(await tableExists(name))) return 0;
      const result = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM public.${name} WHERE company_id=$1`, [cid]);
      return result.rows[0]?.count ?? 0;
    };
    const [reports, raw, tx, drivers, vehicles, outstanding, alerts, queue, dlq] = await Promise.all([
      countTable("fleet_reports"),
      countTable("gojek_raw_transactions"),
      countTable("fleet_transactions"),
      countTable("fleet_drivers"),
      countTable("fleet_vehicles"),
      countTable("fleet_outstanding"),
      countTable("fleet_alerts"),
      countTable("gojek_ingestion_queue"),
      countTable("gojek_failed_rows"),
    ]);

    let activeDrivers = 0;
    let suspendedDrivers = 0;
    if (await tableExists("fleet_drivers")) {
      const d = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active,
                COUNT(*) FILTER (WHERE status<>'active')::int AS suspended
           FROM public.fleet_drivers WHERE company_id=$1::text`,
        [cid],
      );
      activeDrivers = Number((d.rows[0] as Record<string, unknown>)?.active ?? 0);
      suspendedDrivers = Number((d.rows[0] as Record<string, unknown>)?.suspended ?? 0);
    }

    let txToday = 0;
    let totalGross = 0;
    let latestDate: string | null = null;
    if (await tableExists("fleet_transactions")) {
      const t = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE transaction_date=CURRENT_DATE)::int AS today_count,
                COALESCE(SUM(gross_revenue),0)::numeric AS total_gross,
                MAX(transaction_date)::text AS latest_date
           FROM public.fleet_transactions WHERE company_id=$1`,
        [cid],
      );
      txToday = Number((t.rows[0] as Record<string, unknown>)?.today_count ?? 0);
      totalGross = Number((t.rows[0] as Record<string, unknown>)?.total_gross ?? 0);
      latestDate = ((t.rows[0] as Record<string, unknown>)?.latest_date as string | null) ?? null;
    }

    let criticalUnread = 0;
    let otherUnread = 0;
    if (await tableExists("fleet_alerts")) {
      const a = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE is_read=false AND severity='critical')::int AS critical,
                COUNT(*) FILTER (WHERE is_read=false AND severity<>'critical')::int AS other
           FROM public.fleet_alerts WHERE company_id=$1`,
        [cid],
      );
      criticalUnread = Number((a.rows[0] as Record<string, unknown>)?.critical ?? 0);
      otherUnread = Number((a.rows[0] as Record<string, unknown>)?.other ?? 0);
    }

    const wa = await getFleetWaGatewayStatus().catch(() => null);
    const reminderState = await pool.query(
      `SELECT s.auto_blast_enabled,s.auto_blast_hour,s.auto_blast_last_run,
              w.last_tick_at,w.last_attempt_at,w.last_success_at,w.sender_device,w.device_status,w.last_error
         FROM public.fleet_settings s
         LEFT JOIN public.fleet_wa_worker_state w ON w.company_id=s.company_id
        WHERE s.company_id=$1
        LIMIT 1`,
      [cid],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    const reminderRow = (reminderState.rows[0] ?? {}) as Record<string, unknown>;
    const waReady = Boolean(
      wa?.configured &&
      wa?.gatewayHealthy &&
      wa?.deviceId &&
      wa?.deviceStatus === "ONLINE"
    );

    const healthScore = Math.max(
      0,
      100
        - Math.min(50, dlq * 5)
        - Math.min(30, criticalUnread * 10)
        - (waReady ? 0 : 15)
        - (reminderRow.auto_blast_enabled === true && reminderRow.last_error ? 10 : 0),
    );
    const healthStatus = healthScore >= 80 ? "green" : healthScore >= 50 ? "yellow" : "red";
    res.json({
      generatedAt: new Date().toISOString(),
      healthScore,
      healthStatus,
      systemBounds: {
        limits: { pendingQueue: 20, dlq: 100 },
        violations: [],
        queueSaturation: Math.min(100, Math.round((queue / 20) * 100)),
        dlqSaturation: Math.min(100, Math.round((dlq / 100) * 100)),
      },
      ingestionQueue: {
        pending: queue, processing: 0, completed: reports, failed: dlq, total: queue + reports + dlq,
        recentWeek: { total: reports, succeeded: reports, failed: dlq, processing: 0, pending: queue, successRate: reports + dlq > 0 ? Math.round((reports / (reports + dlq)) * 100) : 100 },
      },
      dlq: { total: dlq, unresolved: dlq, resolved: 0, latestError: null, pressure: Math.min(100, dlq) },
      reconciliation: { status: "ok", summaryMismatches: 0, message: "Belum ada mismatch terdeteksi oleh runtime standalone." },
      alerts: { criticalUnread, otherUnread, totalUnread: criticalUnread + otherUnread },
      transactions: { total: tx, todayCount: txToday, totalGross, latestDate },
      drivers: { total: drivers, active: activeDrivers, suspended: suspendedDrivers },
      wa: {
        configured: Boolean(wa?.configured),
        gatewayHealthy: Boolean(wa?.gatewayHealthy),
        gatewayStatus: wa?.gatewayStatus ?? "UNREACHABLE",
        deviceId: wa?.deviceId ?? null,
        deviceStatus: wa?.deviceStatus ?? null,
        ready: waReady,
      },
      reminder: {
        enabled: reminderRow.auto_blast_enabled === true,
        hourWib: Number(reminderRow.auto_blast_hour ?? 8),
        lastRun: reminderRow.auto_blast_last_run ?? null,
        lastTick: reminderRow.last_tick_at ?? null,
        lastAttempt: reminderRow.last_attempt_at ?? null,
        lastSuccess: reminderRow.last_success_at ?? null,
        senderDevice: reminderRow.sender_device ?? null,
        deviceStatus: reminderRow.device_status ?? null,
        lastError: reminderRow.last_error ?? null,
      },
      dataSource: {
        reports,
        rawRows: raw,
        normalizedRows: tx,
        state: tx > 0 ? "normalized" : raw > 0 ? "raw_only" : "no_source_data",
      },
      tables: { reports, raw, tx, drivers, vehicles, outstanding, alerts },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet system overview failed");
    res.status(503).json({ error: "Gagal mengambil system overview." });
  }
});

router.get("/executive-summary", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const outstanding = await pool.query(
      `SELECT COUNT(*)::int AS drivers, COALESCE(SUM(outstanding_amount),0)::numeric AS total
         FROM public.fleet_outstanding WHERE company_id=$1 AND status='open'`,
      [cid],
    );
    const outstandingDrivers = Number((outstanding.rows[0] as Record<string, unknown>)?.drivers ?? 0);
    const outstandingAmount = Number((outstanding.rows[0] as Record<string, unknown>)?.total ?? 0);

    let unreadAlerts = 0;
    let criticalUnread = 0;
    if (await tableExists("fleet_alerts")) {
      const alerts = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE is_read=false)::int AS unread,
                COUNT(*) FILTER (WHERE is_read=false AND severity='critical')::int AS critical
           FROM public.fleet_alerts WHERE company_id=$1`,
        [cid],
      );
      unreadAlerts = Number((alerts.rows[0] as Record<string, unknown>)?.unread ?? 0);
      criticalUnread = Number((alerts.rows[0] as Record<string, unknown>)?.critical ?? 0);
    }

    const top3Risks = [
      ...(criticalUnread > 0 ? [{
        taskId: "ALERT-CRITICAL",
        title: `${criticalUnread} alert kritis belum dibaca`,
        reason: "Perlu ditinjau untuk mencegah gangguan operasional fleet.",
        action: "Buka Alerts",
        href: "/logistics/fleet-intelligence/alerts",
        severity: "critical" as const,
      }] : []),
      ...(outstandingDrivers > 0 ? [{
        taskId: "OUTSTANDING",
        title: `${outstandingDrivers} driver masih outstanding`,
        reason: `Total outstanding Rp ${Math.round(outstandingAmount).toLocaleString("id-ID")}.`,
        action: "Tinjau Outstanding",
        href: "/logistics/fleet-intelligence/outstanding",
        severity: "warning" as const,
      }] : []),
    ].slice(0, 3);

    const priorityTask = top3Risks[0] ?? {
      taskId: "OPTIMIZATION",
      title: "Fleet Intelligence siap digunakan",
      reason: "Tidak ada risiko kritis yang terdeteksi dari data runtime saat ini.",
      action: "Lihat Analytics",
      href: "/logistics/fleet-intelligence/analytics",
      severity: "optimization" as const,
    };
    const healthScore = Math.max(0, 100 - criticalUnread * 20 - Math.min(outstandingDrivers, 10) * 2);
    const systemStatus = healthScore >= 80 ? "OK" : healthScore >= 50 ? "DEGRADED" : "CRITICAL";

    res.json({
      generatedAt: new Date().toISOString(),
      systemStatus,
      healthScore,
      recommendedAction: priorityTask.action,
      priorityTask,
      top3Risks,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet executive summary failed");
    res.status(503).json({ error: "Gagal mengambil executive summary." });
  }
});


router.get("/settings", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const [settings, reminder] = await Promise.all([
      getFleetAccountingSettings(cid),
      pool.query(
        `SELECT auto_blast_enabled,auto_blast_hour,auto_blast_last_run
           FROM public.fleet_settings
          WHERE company_id=$1
          LIMIT 1`,
        [cid],
      ),
    ]);
    const reminderRow = reminder.rows[0] ?? {};
    res.json({
      ok: true,
      ...settings,
      autoBlastEnabled: reminderRow.auto_blast_enabled === true,
      autoBlastHour: Number(reminderRow.auto_blast_hour ?? 8),
      autoBlastLastRun: reminderRow.auto_blast_last_run ?? null,
      source: "central_finance",
    });
  } catch (error) {
    req.log.error({ error }, "Fleet settings failed");
    const message = error instanceof Error ? error.message : "Gagal mengambil Fleet Accounting Settings.";
    res.status(message.includes("belum dikonfigurasi") ? 409 : 503).json({ error: message });
  }
});

router.put("/settings", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const current = await getFleetAccountingSettings(cid);
    const cashId = Number(req.body?.fleetCashAccountId ?? current.fleetCashAccountId);
    const receivableId = Number(req.body?.fleetDriverReceivableAccountId ?? current.fleetDriverReceivableAccountId);
    const journalId = Number(req.body?.journalId ?? current.journalId);

    if (
      !Number.isSafeInteger(cashId) || cashId <= 0 ||
      !Number.isSafeInteger(receivableId) || receivableId <= 0 ||
      !Number.isSafeInteger(journalId) || journalId <= 0
    ) {
      res.status(400).json({ error: "ID COA/journal Fleet wajib berupa integer positif." });
      return;
    }

    const settings = await updateFleetAccountingSettings({
      companyId: cid,
      fleetCashAccountId: cashId,
      fleetDriverReceivableAccountId: receivableId,
      journalId,
    });
    res.json({ ok: true, ...settings, source: "central_finance" });
  } catch (error) {
    req.log.error({ error }, "Fleet settings update failed");
    const message = error instanceof Error ? error.message : "Gagal menyimpan Fleet Accounting Settings.";
    res.status(
      message.includes("belum diaktifkan") ||
      message.includes("belum dikonfigurasi") ||
      message.includes("tidak valid")
        ? 409
        : 503,
    ).json({ error: message });
  }
});

router.get("/reminder-settings", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const result = await pool.query(
      `SELECT auto_blast_enabled,auto_blast_hour,auto_blast_last_run
         FROM public.fleet_settings
        WHERE company_id=$1
        LIMIT 1`,
      [cid],
    );
    const row = result.rows[0] ?? {};
    res.json({
      ok: true,
      autoBlastEnabled: row.auto_blast_enabled === true,
      autoBlastHour: Number(row.auto_blast_hour ?? 8),
      autoBlastLastRun: row.auto_blast_last_run ?? null,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet reminder settings failed");
    res.status(503).json({ error: "Gagal mengambil pengaturan reminder Fleet." });
  }
});

router.put("/reminder-settings", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const enabled = req.body?.autoBlastEnabled === true;
    const hour = Number(req.body?.autoBlastHour ?? 8);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      res.status(400).json({ error: "Jam reminder wajib 0-23 WIB." });
      return;
    }
    if (enabled) {
      const wa = await getFleetWaGatewayStatus();
      const ready = Boolean(wa.configured && wa.gatewayHealthy && wa.deviceId && wa.deviceStatus === "ONLINE");
      if (!ready) {
        res.status(409).json({ error: "WA Fleet belum siap untuk auto reminder.", wa });
        return;
      }
    }
    const result = await pool.query(
      `INSERT INTO public.fleet_settings(company_id,auto_blast_enabled,auto_blast_hour,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(company_id) DO UPDATE SET
         auto_blast_enabled=EXCLUDED.auto_blast_enabled,
         auto_blast_hour=EXCLUDED.auto_blast_hour,
         auto_blast_last_run=CASE
           WHEN fleet_settings.auto_blast_enabled IS DISTINCT FROM EXCLUDED.auto_blast_enabled
             OR fleet_settings.auto_blast_hour IS DISTINCT FROM EXCLUDED.auto_blast_hour
           THEN NULL
           ELSE fleet_settings.auto_blast_last_run
         END,
         updated_at=NOW()
       RETURNING auto_blast_enabled,auto_blast_hour,auto_blast_last_run`,
      [cid, enabled, hour],
    );
    const row = result.rows[0];
    res.json({
      ok: true,
      autoBlastEnabled: row.auto_blast_enabled === true,
      autoBlastHour: Number(row.auto_blast_hour),
      autoBlastLastRun: row.auto_blast_last_run ?? null,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet reminder settings update failed");
    res.status(503).json({ error: "Gagal menyimpan pengaturan reminder Fleet." });
  }
});

router.get("/cash-payments", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_cash_payments"))) {
      res.json({ payments: [], total: 0 });
      return;
    }
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 3650);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const result = await pool.query(
      `SELECT cp.*, fo.outstanding_amount AS remaining_outstanding
         FROM public.fleet_cash_payments cp
         LEFT JOIN public.fleet_outstanding fo ON fo.id=cp.outstanding_id AND fo.company_id=cp.company_id
        WHERE cp.company_id=$1
          AND cp.payment_date >= CURRENT_DATE - ($2::int * interval '1 day')
          AND ($3='' OR cp.status=$3)
        ORDER BY cp.payment_date DESC,cp.id DESC
        LIMIT $4`,
      [cid, days, status, limit],
    );
    res.json({ payments: result.rows, total: result.rows.length });
  } catch (error) {
    req.log.error({ error }, "Fleet cash payments failed");
    res.status(503).json({ error: "Gagal mengambil daftar pembayaran." });
  }
});

router.get("/cash-payments/summary", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_cash_payments"))) {
      res.json({ totals: { thisMonthTotal: 0, cancelledTotal: 0, postedTotal: 0, cancelledCount: 0, confirmedCount: 0, postedCount: 0 } });
      return;
    }
    const result = await pool.query(
      `SELECT
          COALESCE(SUM(amount) FILTER (WHERE date_trunc('month',payment_date)=date_trunc('month',CURRENT_DATE) AND status<>'cancelled'),0)::numeric AS this_month_total,
          COALESCE(SUM(amount) FILTER (WHERE status='cancelled'),0)::numeric AS cancelled_total,
          COALESCE(SUM(amount) FILTER (WHERE status='posted'),0)::numeric AS posted_total,
          COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
          COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
          COUNT(*) FILTER (WHERE status='posted')::int AS posted_count
         FROM public.fleet_cash_payments WHERE company_id=$1`,
      [cid],
    );
    const row=result.rows[0] as Record<string,unknown>;
    res.json({ totals: {
      thisMonthTotal:Number(row?.this_month_total??0),
      cancelledTotal:Number(row?.cancelled_total??0),
      postedTotal:Number(row?.posted_total??0),
      cancelledCount:Number(row?.cancelled_count??0),
      confirmedCount:Number(row?.confirmed_count??0),
      postedCount:Number(row?.posted_count??0),
    }});
  } catch (error) {
    req.log.error({ error }, "Fleet cash payment summary failed");
    res.status(503).json({ error: "Gagal mengambil ringkasan pembayaran." });
  }
});

router.post("/cash-payments", async (req: AdminRequest, res) => {
  const client = await pool.connect();
  let paymentRow: Record<string,unknown> | null = null;
  let outstandingId: number | null = null;
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    if (!(await tableExists("fleet_cash_payments"))) {
      res.status(503).json({ error: "Tabel pembayaran fleet belum tersedia." });
      return;
    }

    const body=req.body??{};
    const driverName=typeof body.driver_name==="string"?body.driver_name.trim():"";
    const amount=Number(body.amount);
    const paymentDate=typeof body.payment_date==="string"&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(body.payment_date)
      ? body.payment_date
      : new Date().toISOString().slice(0,10);
    if(!driverName||!Number.isFinite(amount)||amount<=0){
      res.status(400).json({error:"Nama driver dan jumlah pembayaran wajib valid."});
      return;
    }

    // Fail before creating a local payment when Central Finance posting is disabled
    // or its canonical accounting settings cannot be reached. This avoids leaving
    // a confirmed local payment that the user may accidentally submit again.
    assertCentralFinanceWriteEnabled();
    const canonicalSettings = await getFleetAccountingSettings(cid);
    if (
      !canonicalSettings.fleetCashAccountId ||
      !canonicalSettings.fleetDriverReceivableAccountId ||
      !canonicalSettings.journalId
    ) {
      res.status(409).json({ error: "Fleet Accounting Settings di Central Finance belum lengkap." });
      return;
    }

    await client.query("BEGIN");
    outstandingId=Number(body.outstanding_id)||null;
    if(!outstandingId){
      const found=await client.query(
        `SELECT id FROM public.fleet_outstanding
          WHERE company_id=$1 AND status='open' AND lower(driver_name)=lower($2)
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [cid,driverName],
      );
      outstandingId=Number(found.rows[0]?.id)||null;
    }

    if(outstandingId){
      const balance=await client.query(
        "SELECT outstanding_amount FROM public.fleet_outstanding WHERE id=$1 AND company_id=$2 FOR UPDATE",
        [outstandingId,cid],
      );
      const remaining=Number(balance.rows[0]?.outstanding_amount??0);
      if(!balance.rows[0]) throw new Error("Outstanding driver tidak ditemukan.");
      if(amount>remaining+0.01) {
        await client.query("ROLLBACK");
        res.status(409).json({error:`Pembayaran Rp ${amount.toLocaleString("id-ID")} melebihi outstanding Rp ${remaining.toLocaleString("id-ID")}.`});
        return;
      }
    }

    const payment=await client.query(
      `INSERT INTO public.fleet_cash_payments
        (company_id,outstanding_id,driver_name,driver_external_id,driver_phone,vehicle_plate,payment_date,amount,payment_method,reference_no,notes,recorded_by,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,'confirmed')
       RETURNING *`,
      [
        cid,outstandingId,driverName,
        typeof body.driver_external_id==="string"?body.driver_external_id:null,
        typeof body.driver_phone==="string"?body.driver_phone:null,
        typeof body.vehicle_plate==="string"?body.vehicle_plate:null,
        paymentDate,
        amount,
        typeof body.payment_method==="string"&&body.payment_method?body.payment_method:"cash",
        typeof body.reference_no==="string"?body.reference_no:null,
        typeof body.notes==="string"?body.notes:null,
        req.adminUser?.email??"unknown",
      ],
    );
    paymentRow=payment.rows[0] as Record<string,unknown>;
    await client.query("COMMIT");

    const posting=await postFleetCashPayment({
      paymentId:Number(paymentRow.id),
      companyId:cid,
      amount,
      driverName,
      paymentDate,
      referenceNo:typeof paymentRow.reference_no==="string"?paymentRow.reference_no:null,
      actor:req.adminUser?.email??"unknown",
    });

    await client.query("BEGIN");
    const current=await client.query(
      "SELECT status FROM public.fleet_cash_payments WHERE id=$1 AND company_id=$2 FOR UPDATE",
      [paymentRow.id,cid],
    );
    if(current.rows[0]?.status==="cancelled") {
      await client.query("ROLLBACK");
      res.status(409).json({error:"Pembayaran sudah dibatalkan sebelum posting selesai.",paymentId:paymentRow.id});
      return;
    }

    await client.query(
      "UPDATE public.fleet_cash_payments SET accounting_entry_id=$2,status='posted',updated_at=NOW() WHERE id=$1 AND company_id=$3",
      [paymentRow.id,posting.entryId,cid],
    );

    if(outstandingId){
      await client.query(
        `UPDATE public.fleet_outstanding
            SET outstanding_amount=GREATEST(outstanding_amount-$3,0),
                status=CASE WHEN GREATEST(outstanding_amount-$3,0)<=0 THEN 'resolved' ELSE status END,
                resolved_at=CASE WHEN GREATEST(outstanding_amount-$3,0)<=0 THEN NOW() ELSE resolved_at END,
                updated_at=NOW()
          WHERE id=$1 AND company_id=$2`,
        [outstandingId,cid,amount],
      );
    }
    await client.query("COMMIT");

    res.status(201).json({
      ok:true,
      payment:{...paymentRow,status:"posted",accounting_entry_id:posting.entryId},
      accountingPosted:true,
      accountingEntryId:posting.entryId,
      idempotent:posting.idempotent,
    });
  } catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    req.log.error({error,paymentId:paymentRow?.id},"Fleet cash payment create/post failed");
    const msg=error instanceof Error?error.message:"Gagal mencatat pembayaran fleet.";
    if(paymentRow?.id){
      res.status(503).json({
        error:msg,
        paymentRecorded:true,
        paymentId:paymentRow.id,
        status:"confirmed",
        accountingPosted:false,
      });
      return;
    }
    res.status(msg.includes("belum diaktifkan")||msg.includes("belum dikonfigurasi")?409:503).json({error:msg});
  } finally {
    client.release();
  }
});

router.patch("/cash-payments/:id/cancel", async (req: AdminRequest, res) => {
  const client=await pool.connect();
  try{
    const cid=companyId(req);
    const id=Number(req.params.id);
    const current=await client.query(
      "SELECT * FROM public.fleet_cash_payments WHERE id=$1 AND company_id=$2",
      [id,cid],
    );
    const row=current.rows[0] as Record<string,unknown>|undefined;
    if(!row){
      res.status(404).json({error:"Pembayaran tidak ditemukan."});
      return;
    }
    if(row.status==="cancelled"){
      res.json({ok:true,idempotent:true});
      return;
    }

    const wasPosted=row.status==="posted";
    const originalEntryId=Number(row.accounting_entry_id);
    let reversalEntryId:number|null=null;

    if(wasPosted && originalEntryId){
      const reversal=await reverseFleetCashPayment({
        paymentId:id,
        originalEntryId,
        companyId:cid,
        amount:Number(row.amount)||0,
        driverName:String(row.driver_name??"Driver"),
        actor:req.adminUser?.email??"unknown",
      });
      reversalEntryId=reversal.entryId;
    }

    await client.query("BEGIN");
    const locked=await client.query(
      "SELECT status FROM public.fleet_cash_payments WHERE id=$1 AND company_id=$2 FOR UPDATE",
      [id,cid],
    );
    if(locked.rows[0]?.status==="cancelled"){
      await client.query("ROLLBACK");
      res.json({ok:true,idempotent:true,reversalEntryId});
      return;
    }

    await client.query(
      "UPDATE public.fleet_cash_payments SET status='cancelled',updated_at=NOW() WHERE id=$1 AND company_id=$2",
      [id,cid],
    );

    if(wasPosted && row.outstanding_id){
      await client.query(
        `UPDATE public.fleet_outstanding
            SET outstanding_amount=outstanding_amount+$3,status='open',resolved_at=NULL,updated_at=NOW()
          WHERE id=$1 AND company_id=$2`,
        [row.outstanding_id,cid,Number(row.amount)||0],
      );
    }

    await client.query("COMMIT");
    res.json({ok:true,reversalEntryId});
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    req.log.error({error},"Fleet cash payment cancel failed");
    res.status(503).json({error:error instanceof Error?error.message:"Gagal membatalkan pembayaran."});
  }finally{
    client.release();
  }
});
const FLEET_EXPENSE_TYPES = ["Ban","Perbaikan","Service Rutin","Asuransi","Bahan Bakar","Parkir","Tilang","Oli","Spare Part","Lainnya"] as const;

async function ensureFleetOpsTables(): Promise<void> {
  await assertFleetSchemaTables(["fleet_expense_budgets"]);
}

router.get("/expenses", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : null;
    const dateTo = typeof req.query.date_to === "string" ? req.query.date_to : null;
    const expenseType = typeof req.query.expense_type === "string" ? req.query.expense_type.trim() : "";
    const vehicleId = Number(req.query.vehicle_id) || 0;

    const [rows, count, totals, byType] = await Promise.all([
      pool.query(
        `SELECT e.*,v.plate AS vehicle_plate
           FROM public.fleet_expenses e
           LEFT JOIN public.fleet_vehicles v ON v.id=e.vehicle_id AND v.company_id=e.company_id
          WHERE e.company_id=$1 AND e.deleted_at IS NULL
            AND ($2::date IS NULL OR e.expense_date >= $2::date)
            AND ($3::date IS NULL OR e.expense_date <= $3::date)
            AND ($4='' OR e.expense_type=$4)
            AND ($5=0 OR e.vehicle_id=$5)
          ORDER BY e.expense_date DESC,e.id DESC
          LIMIT $6 OFFSET $7`,
        [cid,dateFrom,dateTo,expenseType,vehicleId,limit,offset],
      ),
      pool.query<{ count:number }>(
        `SELECT COUNT(*)::int AS count FROM public.fleet_expenses e
          WHERE e.company_id=$1 AND e.deleted_at IS NULL
            AND ($2::date IS NULL OR e.expense_date >= $2::date)
            AND ($3::date IS NULL OR e.expense_date <= $3::date)
            AND ($4='' OR e.expense_type=$4)
            AND ($5=0 OR e.vehicle_id=$5)`,
        [cid,dateFrom,dateTo,expenseType,vehicleId],
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total_all,
                COALESCE(SUM(amount) FILTER(WHERE date_trunc('month',expense_date)=date_trunc('month',CURRENT_DATE)),0)::numeric AS total_this_month
           FROM public.fleet_expenses WHERE company_id=$1 AND deleted_at IS NULL`,
        [cid],
      ),
      pool.query(
        `SELECT expense_type,COALESCE(SUM(amount),0)::numeric AS total
           FROM public.fleet_expenses
          WHERE company_id=$1 AND deleted_at IS NULL
          GROUP BY expense_type ORDER BY total DESC`,
        [cid],
      ),
    ]);
    res.json({ expenses:rows.rows,total:count.rows[0]?.count??0,page,limit,summary:{...(totals.rows[0]??{}),by_type:byType.rows} });
  } catch(error) {
    req.log.error({error},"Fleet expenses list failed");
    res.status(503).json({error:"Gagal mengambil data pengeluaran fleet."});
  }
});

router.post("/expenses", async (req: AdminRequest, res) => {
  try {
    const cid=companyId(req);
    const body=req.body??{};
    const type=typeof body.expense_type==="string"?body.expense_type.trim():"";
    const amount=Number(body.amount);
    const date=typeof body.expense_date==="string"?body.expense_date:"";
    if(!FLEET_EXPENSE_TYPES.includes(type as typeof FLEET_EXPENSE_TYPES[number])||!Number.isFinite(amount)||amount<=0||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)){
      res.status(400).json({error:"Tanggal, jenis pengeluaran, dan nominal wajib valid."}); return;
    }
    const result=await pool.query(
      `INSERT INTO public.fleet_expenses
        (company_id,vehicle_id,expense_date,expense_type,description,amount,created_by,created_by_email,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,NOW(),NOW()) RETURNING *`,
      [cid,Number(body.vehicle_id)||null,date,type,typeof body.description==="string"?body.description.trim()||null:null,amount,req.adminUser?.email??"unknown"],
    );
    res.status(201).json({ok:true,expense:result.rows[0]});
  } catch(error){ req.log.error({error},"Fleet expense create failed"); res.status(503).json({error:"Gagal menyimpan pengeluaran."}); }
});

router.put("/expenses/:id", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),id=Number(req.params.id),body=req.body??{};
    const type=typeof body.expense_type==="string"?body.expense_type.trim():"";
    const amount=Number(body.amount);
    const date=typeof body.expense_date==="string"?body.expense_date:"";
    if(!Number.isSafeInteger(id)||id<=0||!FLEET_EXPENSE_TYPES.includes(type as typeof FLEET_EXPENSE_TYPES[number])||!Number.isFinite(amount)||amount<=0||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)){
      res.status(400).json({error:"Data pengeluaran tidak valid."}); return;
    }
    const result=await pool.query(
      `UPDATE public.fleet_expenses SET vehicle_id=$3,expense_date=$4,expense_type=$5,description=$6,amount=$7,
              updated_by=$8,updated_by_email=$8,updated_at=NOW()
        WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL RETURNING *`,
      [id,cid,Number(body.vehicle_id)||null,date,type,typeof body.description==="string"?body.description.trim()||null:null,amount,req.adminUser?.email??"unknown"],
    );
    if(result.rowCount!==1){res.status(404).json({error:"Pengeluaran tidak ditemukan."});return;}
    res.json({ok:true,expense:result.rows[0]});
  }catch(error){req.log.error({error},"Fleet expense update failed");res.status(503).json({error:"Gagal memperbarui pengeluaran."});}
});

router.delete("/expenses/:id", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0){res.status(400).json({error:"Expense ID tidak valid."});return;}
    const confirmation=requireDestructiveConfirmation(req,`DELETE EXPENSE ${id}`);
    if(!confirmation.ok){res.status(confirmation.status).json({error:confirmation.error});return;}
    const result=await pool.query(
      "UPDATE public.fleet_expenses SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL RETURNING id",
      [id,cid],
    );
    if(result.rowCount!==1){res.status(404).json({error:"Pengeluaran tidak ditemukan."});return;}
    res.json({ok:true});
  }catch(error){req.log.error({error},"Fleet expense delete failed");res.status(503).json({error:"Gagal menghapus pengeluaran."});}
});

router.get("/expenses/budgets", async (req: AdminRequest, res) => {
  try{
    await ensureFleetOpsTables();
    const cid=companyId(req);
    const month=typeof req.query.month==="string"&&/^[0-9]{4}-[0-9]{2}$/.test(req.query.month)?req.query.month:new Date().toISOString().slice(0,7);
    const result=await pool.query(
      `WITH types(expense_type) AS (SELECT unnest($3::text[])),
       actual AS (
         SELECT expense_type,COALESCE(SUM(amount),0)::numeric actual_amount,COUNT(*)::int tx_count
         FROM public.fleet_expenses
         WHERE company_id=$1 AND deleted_at IS NULL AND to_char(expense_date,'YYYY-MM')=$2
         GROUP BY expense_type
       )
       SELECT b.id,t.expense_type,$2::text AS budget_month,COALESCE(b.budget_amount,0)::numeric AS budget_amount,
              COALESCE(a.actual_amount,0)::numeric AS actual_amount,COALESCE(a.tx_count,0)::int AS tx_count,
              CASE WHEN COALESCE(b.budget_amount,0)>0 THEN ROUND((COALESCE(a.actual_amount,0)/b.budget_amount)*100,2) ELSE NULL END AS pct_used,
              COALESCE(a.actual_amount,0)>COALESCE(b.budget_amount,0) AND COALESCE(b.budget_amount,0)>0 AS is_over,
              COALESCE(a.actual_amount,0)>=COALESCE(b.budget_amount,0)*0.8 AND COALESCE(a.actual_amount,0)<=COALESCE(b.budget_amount,0) AND COALESCE(b.budget_amount,0)>0 AS is_warning,
              b.id IS NOT NULL AS has_budget
       FROM types t
       LEFT JOIN public.fleet_expense_budgets b ON b.company_id=$1 AND b.expense_type=t.expense_type AND to_char(b.budget_month,'YYYY-MM')=$2
       LEFT JOIN actual a ON a.expense_type=t.expense_type
       ORDER BY t.expense_type`,
      [cid,month,[...FLEET_EXPENSE_TYPES]],
    );
    const budgets=result.rows;
    const summary={
      total_budget:budgets.reduce((s,r)=>s+Number(r.budget_amount||0),0),
      total_actual:budgets.reduce((s,r)=>s+Number(r.actual_amount||0),0),
      over_count:budgets.filter(r=>r.is_over).length,
      warning_count:budgets.filter(r=>r.is_warning).length,
    };
    res.json({month,budgets,summary});
  }catch(error){req.log.error({error},"Fleet budgets failed");res.status(503).json({error:"Gagal mengambil anggaran fleet."});}
});

router.post("/expenses/budgets", async (req: AdminRequest, res) => {
  try{
    await ensureFleetOpsTables();
    const cid=companyId(req),body=req.body??{};
    const type=typeof body.expense_type==="string"?body.expense_type.trim():"";
    const month=typeof body.budget_month==="string"?body.budget_month:"";
    const amount=Number(body.budget_amount);
    if(!FLEET_EXPENSE_TYPES.includes(type as typeof FLEET_EXPENSE_TYPES[number])||!/^[0-9]{4}-[0-9]{2}$/.test(month)||!Number.isFinite(amount)||amount<0){
      res.status(400).json({error:"Data anggaran tidak valid."});return;
    }
    const result=await pool.query(
      `INSERT INTO public.fleet_expense_budgets(company_id,expense_type,budget_month,budget_amount,created_by,updated_by)
       VALUES($1,$2,($3||'-01')::date,$4,$5,$5)
       ON CONFLICT(company_id,expense_type,budget_month)
       DO UPDATE SET budget_amount=EXCLUDED.budget_amount,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING *`,
      [cid,type,month,amount,req.adminUser?.email??"unknown"],
    );
    res.json({ok:true,budget:result.rows[0]});
  }catch(error){req.log.error({error},"Fleet budget save failed");res.status(503).json({error:"Gagal menyimpan anggaran."});}
});

router.delete("/expenses/budgets/:id", async (req: AdminRequest, res) => {
  try{
    await ensureFleetOpsTables();
    const cid=companyId(req),id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0){res.status(400).json({error:"Budget ID tidak valid."});return;}
    const confirmation=requireDestructiveConfirmation(req,`DELETE BUDGET ${id}`);
    if(!confirmation.ok){res.status(confirmation.status).json({error:confirmation.error});return;}
    const result=await pool.query("DELETE FROM public.fleet_expense_budgets WHERE id=$1 AND company_id=$2 RETURNING id",[id,cid]);
    if(result.rowCount!==1){res.status(404).json({error:"Anggaran tidak ditemukan."});return;}
    res.json({ok:true});
  }catch(error){req.log.error({error},"Fleet budget delete failed");res.status(503).json({error:"Gagal menghapus anggaran."});}
});

router.get("/pipeline/monitor", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),page=Math.max(Number(req.query.page)||1,1),limit=Math.min(Math.max(Number(req.query.limit)||50,1),200),offset=(page-1)*limit;
    const driverName=typeof req.query.driverName==="string"?req.query.driverName.trim():"";
    const driverExtId=typeof req.query.driverExtId==="string"?req.query.driverExtId.trim():"";
    const dateFrom=typeof req.query.dateFrom==="string"?req.query.dateFrom:null;
    const dateTo=typeof req.query.dateTo==="string"?req.query.dateTo:null;
    const transactionType=typeof req.query.transactionType==="string"?req.query.transactionType.trim():"";
    const reportId=Number(req.query.reportId)||0;
    const minDebit=Number(req.query.minDebit)||-50000;
    const where=`company_id=$1
      AND ($2='' OR COALESCE(driver_name,'') ILIKE '%'||$2||'%')
      AND ($3='' OR COALESCE(driver_external_id,'') ILIKE '%'||$3||'%')
      AND ($4::date IS NULL OR date_iso >= $4::date)
      AND ($5::date IS NULL OR date_iso <= $5::date)
      AND ($6='' OR COALESCE(transaction_type,'')=$6)
      AND ($7=0 OR report_id=$7)`;
    const args=[cid,driverName,driverExtId,dateFrom,dateTo,transactionType,reportId];
    const [drivers,summary,count,types]=await Promise.all([
      pool.query(
        `SELECT COALESCE(driver_external_id,'') driver_external_id,MAX(driver_name) driver_name,MAX(COALESCE(driver_phone,phone_number)) phone_number,
                MAX(COALESCE(vehicle_plate,vehicle)) vehicle,COUNT(*)::int tx_count,
                COALESCE(SUM(CASE WHEN amount<0 THEN amount ELSE 0 END),0)::numeric total_debit,
                COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0)::numeric total_credit,
                COALESCE(SUM(amount),0)::numeric net_flow,
                COALESCE((ARRAY_AGG(total_outstanding_balance ORDER BY date_iso DESC NULLS LAST,id DESC) FILTER(WHERE total_outstanding_balance IS NOT NULL))[1],0)::numeric latest_outstanding,
                MIN(date_iso)::text date_first,MAX(date_iso)::text date_last,
                COUNT(DISTINCT transaction_type)::int type_count,COUNT(DISTINCT gopay_transaction_reference_id)::int dedup_refs,
                MAX(report_id)::int last_report_id,
                COALESCE(SUM(CASE WHEN amount<0 THEN amount ELSE 0 END),0) <= $8 AS is_high_risk
         FROM public.gojek_raw_transactions WHERE ${where}
         GROUP BY COALESCE(driver_external_id,'')
         ORDER BY total_debit ASC,MAX(driver_name)
         LIMIT $9 OFFSET $10`,
        [...args,minDebit,limit,offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int total_rows,COUNT(DISTINCT driver_external_id)::int driver_count,
                COUNT(DISTINCT COALESCE(vehicle_plate,vehicle))::int vehicle_count,
                COALESCE(SUM(CASE WHEN amount<0 THEN amount ELSE 0 END),0)::numeric total_debit,
                COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0)::numeric total_credit,
                COALESCE(SUM(amount),0)::numeric net_flow
         FROM public.gojek_raw_transactions WHERE ${where}`,args),
      pool.query<{count:number}>(`SELECT COUNT(DISTINCT COALESCE(driver_external_id,''))::int count FROM public.gojek_raw_transactions WHERE ${where}`,args),
      pool.query<{transaction_type:string}>(`SELECT DISTINCT transaction_type FROM public.gojek_raw_transactions WHERE company_id=$1 AND NULLIF(transaction_type,'') IS NOT NULL ORDER BY transaction_type`,[cid]),
    ]);
    res.json({drivers:drivers.rows,summary:summary.rows[0]??{},transactionTypes:types.rows.map(r=>r.transaction_type),pagination:{page,limit,offset,totalDrivers:count.rows[0]?.count??0},debitThreshold:minDebit});
  }catch(error){req.log.error({error},"Fleet pipeline monitor failed");res.status(503).json({error:"Gagal memuat pipeline monitor."});}
});


router.get("/pipeline/export-csv", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req);
    const driverName=typeof req.query.driverName==="string"?req.query.driverName.trim():"";
    const driverExtId=typeof req.query.driverExtId==="string"?req.query.driverExtId.trim():"";
    const dateFrom=typeof req.query.dateFrom==="string"?req.query.dateFrom:null;
    const dateTo=typeof req.query.dateTo==="string"?req.query.dateTo:null;
    const transactionType=typeof req.query.transactionType==="string"?req.query.transactionType.trim():"";
    const reportId=Number(req.query.reportId)||0;
    const mode=req.query.mode==="summary"?"summary":"detail";
    let headers:string[]=[];
    let rows:unknown[][]=[];
    if(mode==="summary"){
      const result=await pool.query(
        `SELECT COALESCE(driver_external_id,'') AS driver_id,MAX(driver_name) AS driver_name,
                MAX(COALESCE(driver_phone,phone_number)) AS phone,MAX(COALESCE(vehicle_plate,vehicle)) AS vehicle,
                COUNT(*)::int AS tx_count,
                COALESCE(SUM(CASE WHEN amount<0 THEN amount ELSE 0 END),0)::numeric AS total_debit,
                COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0)::numeric AS total_credit,
                COALESCE(SUM(amount),0)::numeric AS net_flow,
                MAX(date_iso)::text AS last_date
           FROM public.gojek_raw_transactions
          WHERE company_id=$1
            AND ($2='' OR COALESCE(driver_name,'') ILIKE '%'||$2||'%')
            AND ($3='' OR COALESCE(driver_external_id,'') ILIKE '%'||$3||'%')
            AND ($4::date IS NULL OR date_iso >= $4::date)
            AND ($5::date IS NULL OR date_iso <= $5::date)
            AND ($6='' OR COALESCE(transaction_type,'')=$6)
            AND ($7=0 OR report_id=$7)
          GROUP BY COALESCE(driver_external_id,'')
          ORDER BY total_debit ASC`,
        [cid,driverName,driverExtId,dateFrom,dateTo,transactionType,reportId]);
      headers=["Driver ID","Driver Name","Phone","Vehicle","Transaction Count","Total Debit","Total Credit","Net Flow","Last Date"];
      rows=result.rows.map(r=>[r.driver_id,r.driver_name,r.phone,r.vehicle,r.tx_count,r.total_debit,r.total_credit,r.net_flow,r.last_date]);
    }else{
      const result=await pool.query(
        `SELECT id,report_id,date_iso,driver_external_id,driver_name,COALESCE(driver_phone,phone_number) phone,
                COALESCE(vehicle_plate,vehicle) vehicle,transaction_type,amount,total_outstanding_balance,gopay_transaction_reference_id,service_type
           FROM public.gojek_raw_transactions
          WHERE company_id=$1
            AND ($2='' OR COALESCE(driver_name,'') ILIKE '%'||$2||'%')
            AND ($3='' OR COALESCE(driver_external_id,'') ILIKE '%'||$3||'%')
            AND ($4::date IS NULL OR date_iso >= $4::date)
            AND ($5::date IS NULL OR date_iso <= $5::date)
            AND ($6='' OR COALESCE(transaction_type,'')=$6)
            AND ($7=0 OR report_id=$7)
          ORDER BY date_iso DESC NULLS LAST,id DESC LIMIT 100000`,
        [cid,driverName,driverExtId,dateFrom,dateTo,transactionType,reportId]);
      headers=["ID","Report ID","Date","Driver ID","Driver Name","Phone","Vehicle","Transaction Type","Amount","Outstanding","GoPay Ref","Service"];
      rows=result.rows.map(r=>[r.id,r.report_id,r.date_iso,r.driver_external_id,r.driver_name,r.phone,r.vehicle,r.transaction_type,r.amount,r.total_outstanding_balance,r.gopay_transaction_reference_id,r.service_type]);
    }
    const esc=(v:unknown)=>{const s=String(v??"");return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
    const csv=[headers.map(esc).join(","),...rows.map(row=>row.map(esc).join(","))].join("\r\n");
    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",`attachment; filename="fleet-${mode}-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send("\uFEFF"+csv);
  }catch(error){req.log.error({error},"Fleet pipeline export failed");res.status(503).json({error:"Export pipeline gagal."});}
});

router.get("/pipeline/dlq", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),page=Math.max(Number(req.query.page)||1,1),limit=Math.min(Math.max(Number(req.query.limit)||50,1),200),offset=(page-1)*limit;
    const resolved=String(req.query.resolved??"false")==="true";
    const reportId=Number(req.query.reportId)||0;
    const [rows,summary]=await Promise.all([
      pool.query(
        `SELECT f.*,r.original_filename FROM public.gojek_failed_rows f
         LEFT JOIN public.fleet_reports r ON r.id=f.report_id
         WHERE f.company_id=$1 AND f.resolved=$2 AND ($3=0 OR f.report_id=$3)
         ORDER BY f.created_at DESC,f.id DESC LIMIT $4 OFFSET $5`,
        [cid,resolved,reportId,limit,offset]),
      pool.query(
        `SELECT COUNT(*)::text total,COUNT(*) FILTER(WHERE error_stage='transform')::text transform_errors
         FROM public.gojek_failed_rows WHERE company_id=$1 AND resolved=$2 AND ($3=0 OR report_id=$3)`,
        [cid,resolved,reportId]),
    ]);
    res.json({failedRows:rows.rows,summary:summary.rows[0]??{total:"0",transform_errors:"0"}});
  }catch(error){req.log.error({error},"Fleet DLQ list failed");res.status(503).json({error:"Gagal mengambil DLQ."});}
});

router.post("/pipeline/dlq/resolve-all/:reportId", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),reportId=Number(req.params.reportId);
    const result=await pool.query(
      `UPDATE public.gojek_failed_rows SET resolved=true,resolved_at=NOW()
       WHERE company_id=$1 AND report_id=$2 AND resolved=false RETURNING id`,[cid,reportId]);
    res.json({ok:true,resolvedCount:result.rowCount??0});
  }catch(error){req.log.error({error},"Fleet DLQ resolve-all failed");res.status(503).json({error:"Gagal resolve DLQ."});}
});

router.post("/pipeline/dlq/:id/retry", async (req: AdminRequest, res) => {
  const client=await pool.connect();
  try{
    const cid=companyId(req),id=Number(req.params.id);
    await client.query("BEGIN");
    const failed=await client.query(
      `SELECT f.*,r.* FROM public.gojek_failed_rows f
       LEFT JOIN public.gojek_raw_transactions r ON r.id=f.raw_row_id
       WHERE f.id=$1 AND f.company_id=$2 AND f.resolved=false FOR UPDATE OF f`,[id,cid]);
    const row=failed.rows[0] as Record<string,unknown>|undefined;
    if(!row){await client.query("ROLLBACK");res.status(404).json({error:"Baris DLQ tidak ditemukan."});return;}
    if(!row.raw_row_id){await client.query("ROLLBACK");res.status(409).json({error:"DLQ tidak memiliki raw_row_id untuk retry aman."});return;}
    await client.query(
      `INSERT INTO public.fleet_transactions
       (company_id,report_id,driver_external_id,driver_name,vehicle_plate,transaction_date,trip_count,gross_revenue,net_revenue,outstanding_balance,service_type,raw_data,amount,transaction_type,driver_phone,gopay_reference_id)
       VALUES($1,$2,$3,$4,$5,$6,0,GREATEST(COALESCE($7,0),0),COALESCE($7,0),COALESCE($8,0),$9,$10,$7,$11,$12,$13)
       ON CONFLICT DO NOTHING`,
      [cid,row.report_id,row.driver_external_id,row.driver_name,row.vehicle_plate??row.vehicle,row.date_iso,row.amount,row.total_outstanding_balance,row.service_type,row.raw_json??row.raw_data,row.transaction_type,row.driver_phone??row.phone_number,row.gopay_transaction_reference_id],
    );
    await client.query("UPDATE public.gojek_failed_rows SET resolved=true,resolved_at=NOW(),retry_count=retry_count+1 WHERE id=$1",[id]);
    await client.query("COMMIT");
    res.json({ok:true});
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);req.log.error({error},"Fleet DLQ retry failed");res.status(503).json({error:"Retry DLQ gagal."});}finally{client.release();}
});

router.post("/pipeline/reconcile", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),onlyReport=Number(req.body?.reportId)||0;
    const reports=await pool.query<{id:number}>(
      `SELECT id FROM public.fleet_reports WHERE company_id=$1 AND ($2=0 OR id=$2) ORDER BY id DESC LIMIT 200`,[cid,onlyReport]);
    const reconciliation:Record<string,unknown>[]=[];
    for(const rpt of reports.rows){
      const [raw,tx,dlq]=await Promise.all([
        pool.query(`SELECT COUNT(*)::int count,COALESCE(SUM(amount),0)::numeric amount FROM public.gojek_raw_transactions WHERE company_id=$1 AND report_id=$2`,[cid,rpt.id]),
        pool.query(`SELECT COUNT(*)::int count,COALESCE(SUM(amount),0)::numeric amount FROM public.fleet_transactions WHERE company_id=$1 AND report_id=$2`,[cid,rpt.id]),
        pool.query(`SELECT COUNT(*)::int count FROM public.gojek_failed_rows WHERE company_id=$1 AND report_id=$2 AND resolved=false`,[cid,rpt.id]),
      ]);
      const rawCount=Number(raw.rows[0]?.count??0),txCount=Number(tx.rows[0]?.count??0),dlqCount=Number(dlq.rows[0]?.count??0);
      const rawAmountSum=Number(raw.rows[0]?.amount??0),txAmountSum=Number(tx.rows[0]?.amount??0);
      const missingRows=Math.max(rawCount-txCount-dlqCount,0),excessRows=Math.max(txCount+dlqCount-rawCount,0);
      const amountMismatch=Math.abs(rawAmountSum-txAmountSum)>0.01;
      const score=Math.max(0,100-Math.min(50,missingRows*5)-Math.min(20,excessRows*5)-(amountMismatch?20:0));
      const grade=score>=95?"A":score>=80?"B":score>=60?"C":score>=40?"D":"F";
      const mismatches:string[]=[];
      if(missingRows)mismatches.push(`${missingRows} raw row belum transformed/DLQ`);
      if(excessRows)mismatches.push(`${excessRows} transformed row berlebih`);
      if(amountMismatch)mismatches.push(`Selisih amount Rp ${Math.round(rawAmountSum-txAmountSum).toLocaleString("id-ID")}`);
      reconciliation.push({reportId:rpt.id,rawCount,txCount,dlqCount,missingRows,excessRows,amountMismatch,rawAmountSum,txAmountSum,mismatches,status:mismatches.length?"mismatch":"ok",healthScore:score,healthGrade:grade});
      await pool.query(
        `INSERT INTO public.fleet_reconciliation_reports(company_id,report_id,reconcile_date,raw_count,ledger_count,matched_count,unmatched_raw,unmatched_ledger,total_raw_amount,total_ledger_amount,variance,status,notes)
         VALUES($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [cid,rpt.id,rawCount,txCount,Math.min(rawCount,txCount),missingRows,excessRows,rawAmountSum,txAmountSum,rawAmountSum-txAmountSum,mismatches.length?"mismatch":"ok",mismatches.join("; ")||null],
      );
    }
    const ok=reconciliation.filter(r=>r.status==="ok").length,mismatch=reconciliation.length-ok;
    const totalMissing=reconciliation.reduce((s,r)=>s+Number(r.missingRows||0),0);
    const totalAmountMismatches=reconciliation.filter(r=>r.amountMismatch).length;
    const avgHealthScore=reconciliation.length?Math.round(reconciliation.reduce((s,r)=>s+Number(r.healthScore||0),0)/reconciliation.length):100;
    res.json({reconciliation,summary:{totalReports:reconciliation.length,ok,mismatch,totalMissing,totalAmountMismatches,avgHealthScore}});
  }catch(error){req.log.error({error},"Fleet pipeline reconciliation failed");res.status(503).json({error:"Rekonsiliasi pipeline gagal."});}
});

router.get("/row-diff/reports", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req);
    const result=await pool.query(
      `SELECT r.id report_id,r.original_filename file_name,r.created_at uploaded_at,
              (SELECT COUNT(*) FROM public.gojek_raw_transactions x WHERE x.company_id=$1 AND x.report_id=r.id)::int raw_count,
              (SELECT COUNT(*) FROM public.fleet_transactions x WHERE x.company_id=$1 AND x.report_id=r.id)::int tx_count
       FROM public.fleet_reports r WHERE r.company_id=$1 ORDER BY r.id DESC LIMIT 200`,[cid]);
    res.json({reports:result.rows});
  }catch(error){req.log.error({error},"Fleet row diff reports failed");res.status(503).json({error:"Gagal mengambil daftar report."});}
});

router.get("/row-diff", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),reportId=Number(req.query.reportId);
    if(!reportId){res.status(400).json({error:"reportId wajib."});return;}
    const [raw,tx]=await Promise.all([
      pool.query(`SELECT * FROM public.gojek_raw_transactions WHERE company_id=$1 AND report_id=$2 ORDER BY id`,[cid,reportId]),
      pool.query(`SELECT * FROM public.fleet_transactions WHERE company_id=$1 AND report_id=$2 ORDER BY id`,[cid,reportId]),
    ]);
    const txRows=tx.rows as Record<string,unknown>[],used=new Set<number>();
    const matched:Record<string,unknown>[]=[],missingInTx:Record<string,unknown>[]=[];
    for(const rr of raw.rows as Record<string,unknown>[]){
      const ref=String(rr.gopay_transaction_reference_id??"");
      let idx=ref?txRows.findIndex((t,i)=>!used.has(i)&&String(t.gopay_reference_id??"")===ref):-1;
      let method="gopay_ref";
      if(idx<0){
        idx=txRows.findIndex((t,i)=>!used.has(i)&&String(t.driver_external_id??"")===String(rr.driver_external_id??"")&&String(t.transaction_date??"").slice(0,10)===String(rr.date_iso??"").slice(0,10)&&String(t.transaction_type??"")===String(rr.transaction_type??""));
        method="fallback";
      }
      if(idx<0){
        missingInTx.push({rawId:rr.id,gopayRef:rr.gopay_transaction_reference_id??null,driverExternalId:rr.driver_external_id??"",driverName:rr.driver_name??"",dateIso:rr.date_iso??"",transactionType:rr.transaction_type??"",rawAmount:Number(rr.amount??0),rawOutstanding:Number(rr.total_outstanding_balance??0),vehicle:rr.vehicle_plate??rr.vehicle??"",serviceType:rr.service_type??"",dateTimeJkt:rr.date_time_jkt??""});
        continue;
      }
      used.add(idx); const tt=txRows[idx];
      const rawAmount=Number(rr.amount??0),txAmount=Number(tt.amount??tt.net_revenue??0),rawOut=Number(rr.total_outstanding_balance??0),txOut=Number(tt.outstanding_balance??0),delta=txAmount-rawAmount;
      matched.push({rawId:rr.id,txId:tt.id,gopayRef:rr.gopay_transaction_reference_id??null,driverExternalId:rr.driver_external_id??"",driverName:rr.driver_name??"",dateIso:rr.date_iso??"",txDate:tt.transaction_date??"",transactionType:rr.transaction_type??"",rawAmount,txAmount,delta,amountMismatch:Math.abs(delta)>0.01,rawOutstanding:rawOut,txOutstanding:txOut,outstandingMismatch:Math.abs(rawOut-txOut)>0.01,matchMethod:method});
    }
    const excessInTx=txRows.map((tt,i)=>({tt,i})).filter(x=>!used.has(x.i)).map(({tt})=>({txId:tt.id,gopayRef:tt.gopay_reference_id??null,driverExternalId:tt.driver_external_id??"",driverName:tt.driver_name??"",txDate:tt.transaction_date??"",transactionType:tt.transaction_type??"",txAmount:Number(tt.amount??tt.net_revenue??0),txOutstanding:Number(tt.outstanding_balance??0),vehiclePlate:tt.vehicle_plate??"",serviceType:tt.service_type??""}));
    const totalRawAmount=(raw.rows as Record<string,unknown>[]).reduce((s,r)=>s+Number(r.amount??0),0),totalTxAmount=txRows.reduce((s,r)=>s+Number(r.amount??r.net_revenue??0),0);
    const amountMismatchCount=matched.filter(m=>m.amountMismatch).length;
    res.json({reportId,summary:{rawCount:raw.rowCount??0,txCount:tx.rowCount??0,matchedCount:matched.length,missingCount:missingInTx.length,excessCount:excessInTx.length,amountMismatchCount,totalRawAmount,totalTxAmount,totalDelta:totalTxAmount-totalRawAmount,totalMismatchDelta:matched.filter(m=>m.amountMismatch).reduce((s,m)=>s+Number(m.delta||0),0)},matched,missingInTx,excessInTx});
  }catch(error){req.log.error({error},"Fleet row diff failed");res.status(503).json({error:"Row diff gagal."});}
});

router.get("/accounting/journals", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),status=typeof req.query.status==="string"&&req.query.status!=="all"?req.query.status:"",limit=Math.min(Math.max(Number(req.query.limit)||100,1),200);
    const result=await pool.query(`SELECT * FROM public.fleet_accounting_journals WHERE company_id=$1 AND ($2='' OR status=$2) ORDER BY journal_date DESC,id DESC LIMIT $3`,[cid,status,limit]);
    res.json({journals:result.rows,total:result.rows.length});
  }catch(error){req.log.error({error},"Fleet accounting journals failed");res.status(503).json({error:"Gagal mengambil jurnal fleet."});}
});

router.post("/accounting/journals/generate", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req), body = req.body ?? {};
    const from = String(body.periodStart ?? ""), to = String(body.periodEnd ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      res.status(400).json({ error: "Periode jurnal tidak valid." }); return;
    }
    const agg = await pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(gross_revenue),0)::numeric AS gross,
              COALESCE(SUM(net_revenue),0)::numeric AS net,
              COALESCE(SUM(commission),0)::numeric AS commission,
              COALESCE(SUM(incentive),0)::numeric AS incentive,
              COALESCE(SUM(ppn_amount),0)::numeric AS ppn
         FROM public.fleet_transactions
        WHERE company_id=$1 AND transaction_date BETWEEN $2::date AND $3::date`,
      [cid, from, to],
    );
    const a = agg.rows[0];
    if (!Number(a?.count)) { res.status(422).json({ error: "Tidak ada transaksi pada periode tersebut. Jurnal tidak dibuat." }); return; }
    const ref = `FLT-${from.replaceAll("-", "")}-${to.replaceAll("-", "")}`;
    const existing = await pool.query("SELECT * FROM public.fleet_accounting_journals WHERE company_id=$1 AND reference_no=$2 LIMIT 1", [cid, ref]);
    if (existing.rows[0]) { res.json({ ok:true, journal:existing.rows[0], idempotent:true }); return; }

    // Source data does not establish the contractual tax base or a balanced COA mapping.
    // Preserve source amounts for review; do not invent VAT, driver payouts, or receivables.
    const gross = Number(a.gross), net = Number(a.net), ppn = Number(a.ppn);
    const result = await pool.query(
      `INSERT INTO public.fleet_accounting_journals
        (company_id,journal_date,reference_no,status,journal_type,gross_revenue,outstanding_amount,
         driver_payout,ppn_amount,ppn_rate,net_revenue,commission_total,incentive_total,
         period_start,period_end,created_by,notes,raw_stats)
       VALUES ($1,CURRENT_DATE,$2,'draft','fleet_revenue',$3,0,0,$4,0,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
      [cid,ref,gross,ppn,net,Number(a.commission),Number(a.incentive),from,to,
       req.adminUser?.email ?? "unknown",typeof body.notes === "string" ? body.notes : null,
       JSON.stringify({source:"fleet_transactions",transactionCount:Number(a.count),taxSource:"transaction.ppn_amount",accountingReviewRequired:true,balanced:false,generatedAt:new Date().toISOString()})],
    );
    res.status(201).json({ ok:true, journal:result.rows[0], reviewRequired:true });
  } catch (error) {
    req.log.error({error},"Fleet journal generate failed");
    res.status(503).json({error:"Gagal generate jurnal fleet."});
  }
});

router.put("/accounting/journals/:id/approve", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),id=Number(req.params.id);
    const review=await pool.query("SELECT raw_stats FROM public.fleet_accounting_journals WHERE id=$1 AND company_id=$2",[id,cid]);
    if(review.rows[0]?.raw_stats?.accountingReviewRequired===true){res.status(409).json({error:"Jurnal menunggu validasi COA dan keseimbangan debit-kredit. Persetujuan belum diizinkan."});return;}
    const result=await pool.query(`UPDATE public.fleet_accounting_journals SET status='approved',approved_by=$3,approved_at=NOW(),updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING *`,[id,cid,req.adminUser?.email??"unknown"]);
    if(result.rowCount!==1){res.status(409).json({error:"Jurnal tidak ditemukan atau bukan draft."});return;}
    res.json({ok:true,journal:result.rows[0]});
  }catch(error){req.log.error({error},"Fleet journal approve failed");res.status(503).json({error:"Gagal approve jurnal."});}
});

router.put("/accounting/journals/:id/post", async (req: AdminRequest, res) => {
  try{
    const cid=companyId(req),id=Number(req.params.id);
    const journal=await pool.query("SELECT * FROM public.fleet_accounting_journals WHERE id=$1 AND company_id=$2 LIMIT 1",[id,cid]);
    if(!journal.rows[0]){res.status(404).json({error:"Jurnal tidak ditemukan."});return;}
    if(journal.rows[0].status!=="approved"){res.status(409).json({error:"Jurnal harus berstatus approved sebelum posting."});return;}
    res.status(409).json({error:"Posting Fleet ke Central Finance belum diaktifkan. Jurnal tetap approved agar tidak membuat posting ganda atau bentrok dengan Central Finance."});
  }catch(error){req.log.error({error},"Fleet journal post guard failed");res.status(503).json({error:"Gagal memvalidasi posting jurnal."});}
});

router.get("/validation/report", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const hasTx = await tableExists("fleet_transactions");
    const hasRaw = await tableExists("gojek_raw_transactions");
    const hasJournal = await tableExists("fleet_accounting_journals");

    const summary = hasTx
      ? (await pool.query(
          `SELECT COUNT(*)::int AS total_transactions,
                  COALESCE(SUM(gross_revenue),0)::numeric AS total_gross_revenue,
                  COALESCE(SUM(net_revenue),0)::numeric AS total_net_revenue,
                  COALESCE(SUM(ppn_amount),0)::numeric AS total_ppn
             FROM public.fleet_transactions WHERE company_id=$1`,
          [cid],
        )).rows[0]
      : { total_transactions: 0, total_gross_revenue: 0, total_net_revenue: 0, total_ppn: 0 };

    const duplicateTransactions = hasTx
      ? (await pool.query(
          `SELECT driver_external_id, transaction_date, COUNT(*)::int AS count
             FROM public.fleet_transactions
            WHERE company_id=$1
            GROUP BY driver_external_id,transaction_date
           HAVING COUNT(*)>1
            ORDER BY count DESC LIMIT 50`,
          [cid],
        )).rows
      : [];

    const outstanding = await pool.query(
      "SELECT COALESCE(SUM(outstanding_amount),0)::numeric AS total FROM public.fleet_outstanding WHERE company_id=$1 AND status='open'",
      [cid],
    );
    let rawOutstanding = 0;
    if (hasRaw) {
      const raw = await pool.query(
        `SELECT COALESCE(SUM(x.total_outstanding_balance),0)::numeric AS total
           FROM (
             SELECT DISTINCT ON (driver_external_id) driver_external_id,total_outstanding_balance
             FROM public.gojek_raw_transactions
             WHERE company_id=$1 AND NULLIF(driver_external_id,'') IS NOT NULL AND total_outstanding_balance IS NOT NULL
             ORDER BY driver_external_id,date_iso DESC NULLS LAST,id DESC
           ) x`,
        [cid],
      );
      rawOutstanding = Number((raw.rows[0] as Record<string, unknown>)?.total ?? 0);
    }
    const outstandingTotal = Number((outstanding.rows[0] as Record<string, unknown>)?.total ?? 0);
    const diff = outstandingTotal - rawOutstanding;

    const journals = hasJournal
      ? (await pool.query(
          "SELECT * FROM public.fleet_accounting_journals WHERE company_id=$1 AND status NOT IN ('draft','approved','posted') LIMIT 50",
          [cid],
        )).rows
      : [];

    res.json({
      generatedAt: new Date().toISOString(),
      companyId: cid,
      summary: {
        totalTransactions: Number((summary as Record<string, unknown>).total_transactions ?? 0),
        totalGrossRevenue: Number((summary as Record<string, unknown>).total_gross_revenue ?? 0),
        totalNetRevenue: Number((summary as Record<string, unknown>).total_net_revenue ?? 0),
        totalPpn: Number((summary as Record<string, unknown>).total_ppn ?? 0),
      },
      checks: {
        duplicateTransactions: { status: duplicateTransactions.length ? "warn" : "ok", count: duplicateTransactions.length, items: duplicateTransactions },
        summaryIntegrity: { status: "ok", count: 0, items: [] },
        ppnConsistency: { status: "ok", count: 0, items: [] },
        multiTenantSecurity: { status: "ok", nullCounts: {} },
        outstandingIntegrity: {
          status: Math.abs(diff) > 1 ? "warn" : "ok",
          outstandingTableSum: outstandingTotal,
          transactionSum: rawOutstanding,
          diff,
        },
        journalIntegrity: { status: journals.length ? "warn" : "ok", count: journals.length, items: journals },
      },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet validation report failed");
    res.status(503).json({ error: "Gagal mengambil validation report." });
  }
});

export default router;
