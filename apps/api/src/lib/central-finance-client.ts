type Json = Record<string, unknown>;

function required(value: unknown, name: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${name} belum dikonfigurasi.`);
  return v;
}

function clientConfig(options: { requireToken?: boolean } = {}) {
  const baseUrl = String(process.env.CENTRAL_FINANCE_BASE_URL ?? "").trim().replace(/\/$/, "");
  const token = String(process.env.CENTRAL_FINANCE_SERVICE_TOKEN ?? "").trim();
  if (options.requireToken) {
    required(baseUrl, "CENTRAL_FINANCE_BASE_URL");
    required(token, "CENTRAL_FINANCE_SERVICE_TOKEN");
  }
  return {
    baseUrl,
    token,
    writeEnabled: String(process.env.CENTRAL_FINANCE_WRITE_ENABLED ?? "false").toLowerCase() === "true",
  };
}

async function request(path: string, init: RequestInit = {}): Promise<Json> {
  const cfg = clientConfig({ requireToken: true });
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${cfg.token}`,
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as Json;
  if (!response.ok) {
    throw new Error(String(payload.error ?? payload.message ?? `Central Finance HTTP ${response.status}`));
  }
  return payload;
}

export function assertCentralFinanceWriteEnabled() {
  if (String(process.env.CENTRAL_FINANCE_WRITE_ENABLED ?? "false").toLowerCase() !== "true") {
    throw new Error("Posting Central Finance dari Fleet belum diaktifkan.");
  }
}

async function getFleetAccountingSettingsDirect(companyId: number) {
  const { pool } = await import("./db");
  const result = await pool.query(
    `SELECT s.fleet_cash_account_id,
            s.fleet_driver_receivable_account_id,
            COALESCE(
              s.cash_journal_id,
              s.bank_journal_id,
              (SELECT id
                 FROM public.accounting_journals j
                WHERE j.company_id=$1
                  AND COALESCE(j.is_active,true)=true
                ORDER BY id
                LIMIT 1)
            ) AS journal_id
       FROM public.accounting_settings s
      WHERE s.company_id=$1
      LIMIT 1`,
    [companyId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const fleetCashAccountId = Number(row?.fleet_cash_account_id) || null;
  const fleetDriverReceivableAccountId = Number(row?.fleet_driver_receivable_account_id) || null;
  const journalId = Number(row?.journal_id) || null;
  if (!fleetCashAccountId || !fleetDriverReceivableAccountId || !journalId) {
    throw new Error("Fleet Cash Payment COA/journal belum dikonfigurasi.");
  }
  return { fleetCashAccountId, fleetDriverReceivableAccountId, journalId };
}

export async function getFleetAccountingSettings(companyId: number) {
  const cfg = clientConfig();
  if (!cfg.baseUrl || !cfg.token) {
    if (cfg.writeEnabled) {
      throw new Error("Central Finance service token wajib sebelum write diaktifkan.");
    }
    return getFleetAccountingSettingsDirect(companyId);
  }

  const result = await request(`/api/integrations/fleet/companies/${encodeURIComponent(companyId)}/accounting-settings`);
  return {
    fleetCashAccountId: Number(result.fleetCashAccountId) || null,
    fleetDriverReceivableAccountId: Number(result.fleetDriverReceivableAccountId) || null,
    journalId: Number(result.journalId) || null,
  };
}

export async function updateFleetAccountingSettings(args: {
  companyId: number;
  fleetCashAccountId: number;
  fleetDriverReceivableAccountId: number;
  journalId: number;
}) {
  assertCentralFinanceWriteEnabled();
  const key = `fleet-accounting-settings:${args.companyId}:${args.fleetCashAccountId}:${args.fleetDriverReceivableAccountId}:${args.journalId}`;
  const result = await request(
    `/api/integrations/fleet/companies/${encodeURIComponent(args.companyId)}/accounting-settings`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(args),
    },
  );
  return {
    fleetCashAccountId: Number(result.fleetCashAccountId) || null,
    fleetDriverReceivableAccountId: Number(result.fleetDriverReceivableAccountId) || null,
    journalId: Number(result.journalId) || null,
  };
}

export async function postFleetCashPayment(args: {
  companyId: number;
  paymentId: number;
  amount: number;
  driverName: string;
  paymentDate: string;
  referenceNo?: string | null;
  actor?: string | null;
}) {
  assertCentralFinanceWriteEnabled();
  const key = `fleet-cash-payment:${args.companyId}:${args.paymentId}`;
  const result = await request("/api/integrations/fleet/cash-payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(args),
  });
  const entryId = Number(result.entryId ?? result.accountingEntryId);
  if (!entryId) throw new Error("Central Finance tidak mengembalikan accounting entry ID.");
  return { entryId, idempotent: Boolean(result.idempotent) };
}

export async function reverseFleetCashPayment(args: {
  companyId: number;
  paymentId: number;
  originalEntryId: number;
  amount: number;
  driverName: string;
  actor?: string | null;
}) {
  assertCentralFinanceWriteEnabled();
  const key = `fleet-cash-payment-reversal:${args.companyId}:${args.paymentId}:${args.originalEntryId}`;
  const result = await request("/api/integrations/fleet/cash-payments/reverse", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(args),
  });
  const entryId = Number(result.entryId ?? result.accountingEntryId);
  if (!entryId) throw new Error("Central Finance tidak mengembalikan reversal entry ID.");
  return { entryId, idempotent: Boolean(result.idempotent) };
}
