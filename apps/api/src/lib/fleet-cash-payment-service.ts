import { pool } from "./db";
import {
  assertCentralFinanceWriteEnabled,
  getFleetAccountingSettings,
  postFleetCashPayment,
  reverseFleetCashPayment,
} from "./central-finance-client";

export class FleetCashPaymentError extends Error {
  constructor(message: string, readonly status = 409, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

type CashRow = Record<string, unknown> & {
  id: number;
  company_id: number;
  status: string;
  driver_name: string;
  payment_date: string;
  amount: string | number;
  outstanding_id: number | null;
  accounting_entry_id: number | null;
  reference_no: string | null;
};

export type CreateFleetCashPayment = {
  companyId: number;
  driverName: string;
  amount: number;
  paymentDate: string;
  outstandingId?: number | null;
  driverExternalId?: string | null;
  driverPhone?: string | null;
  vehiclePlate?: string | null;
  paymentMethod?: string;
  referenceNo?: string | null;
  notes?: string | null;
  actor: string;
};

const sourceSql = "SELECT p.*,p.payment_date::text AS payment_date FROM public.fleet_cash_payments p WHERE p.id=$1 AND p.company_id=$2";

function requireIds(companyId: number, paymentId?: number) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 ||
      (paymentId !== undefined && (!Number.isSafeInteger(paymentId) || paymentId <= 0))) {
    throw new FleetCashPaymentError("Identitas pembayaran Fleet tidak valid.", 400);
  }
}

function pendingDetails(paymentId: number) {
  return { paymentRecorded: true, paymentId, status: "confirmed", accountingPosted: false, retryAvailable: true };
}

function postedReceipt(row: CashRow, entryId: number, idempotent: boolean) {
  return {
    ok: true,
    payment: { ...row, status: "posted", accounting_entry_id: entryId },
    accountingPosted: true,
    accountingEntryId: entryId,
    idempotent,
  };
}

function samePayment(left: CashRow, right: CashRow) {
  return Number(left.amount) === Number(right.amount) &&
    left.driver_name === right.driver_name && left.payment_date === right.payment_date &&
    String(left.reference_no ?? "") === String(right.reference_no ?? "") &&
    Number(left.outstanding_id ?? 0) === Number(right.outstanding_id ?? 0);
}

// Called only after the canonical receiver returns. No source row lock crosses HTTP.
async function settlePostedPayment(source: CashRow, entryId: number, remoteIdempotent: boolean) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query<CashRow>(sourceSql + " FOR UPDATE", [source.id, source.company_id])).rows[0];
    if (!current || !samePayment(current, source)) throw new FleetCashPaymentError("Bukti pembayaran Fleet berubah sebelum posting selesai.");
    if (current.status === "posted" && Number(current.accounting_entry_id) === entryId) {
      await client.query("COMMIT");
      return postedReceipt(current, entryId, true);
    }
    if (current.status !== "confirmed" ||
        (current.accounting_entry_id != null && Number(current.accounting_entry_id) !== entryId)) {
      throw new FleetCashPaymentError("Status pembayaran Fleet tidak cocok untuk penyelesaian posting.");
    }
    await client.query(
      "UPDATE public.fleet_cash_payments SET accounting_entry_id=$2,status='posted',updated_at=NOW() WHERE id=$1 AND company_id=$3",
      [current.id, entryId, current.company_id],
    );
    if (current.outstanding_id) {
      const changed = await client.query(
        "UPDATE public.fleet_outstanding SET outstanding_amount=GREATEST(outstanding_amount-$3,0)," +
        "status=CASE WHEN GREATEST(outstanding_amount-$3,0)<=0 THEN 'resolved' ELSE status END," +
        "resolved_at=CASE WHEN GREATEST(outstanding_amount-$3,0)<=0 THEN NOW() ELSE resolved_at END,updated_at=NOW() " +
        "WHERE id=$1 AND company_id=$2",
        [current.outstanding_id, current.company_id, Number(current.amount)],
      );
      if (changed.rowCount !== 1) throw new FleetCashPaymentError("Outstanding pembayaran Fleet tidak ditemukan.");
    }
    await client.query("COMMIT");
    return postedReceipt(current, entryId, remoteIdempotent);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function retryFleetCashPayment(companyId: number, paymentId: number, actor: string) {
  assertCentralFinanceWriteEnabled();
  requireIds(companyId, paymentId);
  const row = (await pool.query<CashRow>(sourceSql, [paymentId, companyId])).rows[0];
  if (!row) throw new FleetCashPaymentError("Pembayaran tidak ditemukan.", 404);
  if (row.status === "posted" && Number(row.accounting_entry_id) > 0) {
    return postedReceipt(row, Number(row.accounting_entry_id), true);
  }
  if (row.status !== "confirmed") throw new FleetCashPaymentError("Hanya pembayaran menunggu posting yang dapat dilanjutkan.");
  try {
    const posting = await postFleetCashPayment({
      companyId, paymentId,
      amount: Number(row.amount),
      driverName: row.driver_name,
      paymentDate: row.payment_date,
      referenceNo: row.reference_no,
      actor,
    });
    return await settlePostedPayment(row, posting.entryId, posting.idempotent);
  } catch (error) {
    throw new FleetCashPaymentError(
      error instanceof Error ? error.message : "Posting Finance belum selesai.",
      error instanceof FleetCashPaymentError ? error.status : 503,
      pendingDetails(paymentId),
    );
  }
}

export async function createFleetCashPayment(args: CreateFleetCashPayment) {
  assertCentralFinanceWriteEnabled();
  requireIds(args.companyId);
  const driverName = args.driverName.trim();
  const cents = Math.round(args.amount * 100);
  if (!driverName || !Number.isFinite(args.amount) || args.amount <= 0 ||
      !Number.isSafeInteger(cents) || Math.abs(args.amount * 100 - cents) > 0.0001 ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(args.paymentDate)) {
    throw new FleetCashPaymentError("Nama driver, tanggal, dan jumlah pembayaran wajib valid.", 400);
  }
  if (args.outstandingId != null && (!Number.isSafeInteger(args.outstandingId) || args.outstandingId <= 0)) {
    throw new FleetCashPaymentError("Outstanding ID tidak valid.", 400);
  }
  // Resolve destination and settings before creating a recoverable source payment.
  const settings = await getFleetAccountingSettings(args.companyId);
  if (!settings.fleetCashAccountId || !settings.fleetDriverReceivableAccountId || !settings.journalId) {
    throw new FleetCashPaymentError("Fleet Accounting Settings di Central Finance belum lengkap.");
  }

  const client = await pool.connect();
  let paymentId: number;
  try {
    await client.query("BEGIN");
    // Serializes new payments for the same source driver, including unlinked payments.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["fleet-cash-create:" + args.companyId + ":" + driverName.toLowerCase()]);
    let outstandingId = args.outstandingId ?? null;
    if (!outstandingId) {
      const found = await client.query(
        "SELECT id FROM public.fleet_outstanding WHERE company_id=$1 AND status='open' AND lower(driver_name)=lower($2) ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [args.companyId, driverName],
      );
      outstandingId = Number(found.rows[0]?.id) || null;
    }
    if (outstandingId) {
      const balance = await client.query(
        "SELECT outstanding_amount,driver_name,driver_external_id FROM public.fleet_outstanding WHERE id=$1 AND company_id=$2 FOR UPDATE",
        [outstandingId, args.companyId],
      );
      if (!balance.rows[0]) throw new FleetCashPaymentError("Outstanding driver tidak ditemukan.", 404);
      const outstanding = balance.rows[0];
      const externalId = String(args.driverExternalId ?? "").trim();
      const outstandingExternalId = String(outstanding.driver_external_id ?? "").trim();
      if (String(outstanding.driver_name ?? "").trim().toLowerCase() !== driverName.toLowerCase() ||
          (externalId && outstandingExternalId && externalId !== outstandingExternalId)) {
        throw new FleetCashPaymentError("Outstanding tidak sesuai dengan driver pembayaran.");
      }
      if (cents > Math.round(Number(outstanding.outstanding_amount) * 100)) {
        throw new FleetCashPaymentError("Pembayaran melebihi outstanding driver.");
      }
    }
    // Do not lock the pending cash row while holding the outstanding lock:
    // settlement locks cash first and then updates outstanding.
    const pending = await client.query(
      "SELECT id FROM public.fleet_cash_payments WHERE company_id=$1 AND status='confirmed' " +
      "AND (lower(driver_name)=lower($2) OR ($3::int IS NOT NULL AND outstanding_id=$3)) ORDER BY id LIMIT 1",
      [args.companyId, driverName, outstandingId],
    );
    if (pending.rows[0]) {
      throw new FleetCashPaymentError(
        "Pembayaran sebelumnya menunggu posting. Lanjutkan pembayaran yang sudah tercatat.",
        409, pendingDetails(Number(pending.rows[0].id)),
      );
    }
    const inserted = await client.query(
      "INSERT INTO public.fleet_cash_payments " +
      "(company_id,outstanding_id,driver_name,driver_external_id,driver_phone,vehicle_plate,payment_date,amount,payment_method,reference_no,notes,recorded_by,status) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,'confirmed') RETURNING id",
      [args.companyId,outstandingId,driverName,args.driverExternalId ?? null,args.driverPhone ?? null,
        args.vehiclePlate ?? null,args.paymentDate,args.amount,args.paymentMethod || "cash",
        args.referenceNo ?? null,args.notes ?? null,args.actor],
    );
    paymentId = Number(inserted.rows[0].id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // The committed source can be verified independently by the existing receiver.
  return retryFleetCashPayment(args.companyId, paymentId, args.actor);
}

export async function cancelFleetCashPayment(companyId: number, paymentId: number, actor: string) {
  assertCentralFinanceWriteEnabled();
  requireIds(companyId, paymentId);
  const source = (await pool.query<CashRow>(sourceSql, [paymentId, companyId])).rows[0];
  if (!source) throw new FleetCashPaymentError("Pembayaran tidak ditemukan.", 404);
  if (source.status === "cancelled") return { ok: true, idempotent: true, reversalEntryId: null };
  const originalEntryId = Number(source.accounting_entry_id);
  if (source.status !== "posted" || !Number.isSafeInteger(originalEntryId) || originalEntryId <= 0) {
    throw new FleetCashPaymentError(
      "Posting Finance belum selesai. Lanjutkan posting pembayaran sebelum membatalkan.",
      409, source.status === "confirmed" ? pendingDetails(paymentId) : {},
    );
  }

  // No local transaction or row lock is held while the receiver validates the source.
  const reversal = await reverseFleetCashPayment({
    companyId, paymentId, originalEntryId, amount: Number(source.amount),
    driverName: source.driver_name, actor,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query<CashRow>(sourceSql + " FOR UPDATE", [paymentId, companyId])).rows[0];
    if (!current || !samePayment(current, source)) throw new FleetCashPaymentError("Bukti pembayaran Fleet berubah saat pembatalan.");
    if (current.status === "cancelled") {
      await client.query("COMMIT");
      return { ok: true, idempotent: true, reversalEntryId: reversal.entryId };
    }
    if (current.status !== "posted" || Number(current.accounting_entry_id) !== originalEntryId) {
      throw new FleetCashPaymentError("Status atau jurnal pembayaran berubah saat pembatalan.");
    }
    await client.query(
      "UPDATE public.fleet_cash_payments SET status='cancelled',updated_at=NOW() WHERE id=$1 AND company_id=$2",
      [paymentId, companyId],
    );
    if (current.outstanding_id) {
      const changed = await client.query(
        "UPDATE public.fleet_outstanding SET outstanding_amount=outstanding_amount+$3,status='open',resolved_at=NULL,updated_at=NOW() WHERE id=$1 AND company_id=$2",
        [current.outstanding_id, companyId, Number(current.amount)],
      );
      if (changed.rowCount !== 1) throw new FleetCashPaymentError("Outstanding pembayaran Fleet tidak ditemukan.");
    }
    await client.query("COMMIT");
    return { ok: true, idempotent: reversal.idempotent, reversalEntryId: reversal.entryId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
