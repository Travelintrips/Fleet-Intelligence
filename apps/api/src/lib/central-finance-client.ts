import { pool } from "./db";

type Json = Record<string, unknown>;

type FleetFinanceScope = {
  sourceCompanyId: number;
  companyId: number;
  mapped: boolean;
};

// Fleet ownership remains unchanged. Only the Finance request destination is mapped.
function financeScope(sourceCompanyId: number, requireMapping = false): FleetFinanceScope {
  if (!Number.isSafeInteger(sourceCompanyId) || sourceCompanyId <= 0) {
    throw new Error("Perusahaan sumber Fleet tidak valid.");
  }
  const raw = String(process.env.FLEET_FINANCE_COMPANY_MAP ?? "").trim();
  if (!raw) {
    if (requireMapping) throw new Error("Mapping perusahaan Fleet Finance belum dikonfigurasi.");
    return { sourceCompanyId, companyId: sourceCompanyId, mapped: false };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error("Mapping perusahaan Fleet Finance tidak valid.");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Mapping perusahaan Fleet Finance tidak valid.");
  }
  const entries = Object.entries(parsed);
  if (!entries.length) throw new Error("Mapping perusahaan Fleet Finance tidak valid.");
  const destinations = new Map<number, number>();
  for (const [source, destination] of entries) {
    const sourceId = Number(source);
    if (!/^[1-9][0-9]*$/.test(source) || !Number.isSafeInteger(sourceId) ||
        typeof destination !== "number" || !Number.isSafeInteger(destination) || destination <= 0) {
      throw new Error("Mapping perusahaan Fleet Finance tidak valid.");
    }
    destinations.set(sourceId, destination);
  }
  const companyId = destinations.get(sourceCompanyId);
  if (!companyId) throw new Error("Perusahaan sumber Fleet tidak memiliki mapping Finance.");
  return { sourceCompanyId, companyId, mapped: true };
}

function assertFinanceResponseScope(result: Json, scope: FleetFinanceScope) {
  if (scope.mapped &&
      (result.companyId !== scope.companyId || result.sourceCompanyId !== scope.sourceCompanyId)) {
    throw new Error("Respons Central Finance tidak sesuai perusahaan sumber dan tujuan.");
  }
}

function mappedIdentity(scope: FleetFinanceScope) {
  return { companyId: scope.companyId, sourceCompanyId: scope.sourceCompanyId };
}

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
  const scope = financeScope(companyId, cfg.writeEnabled);
  if (!cfg.baseUrl || !cfg.token) {
    if (cfg.writeEnabled) {
      throw new Error("Central Finance service token wajib sebelum write diaktifkan.");
    }
    if (scope.mapped) {
      throw new Error("Central Finance API wajib untuk mapping perusahaan Fleet.");
    }
    return getFleetAccountingSettingsDirect(scope.sourceCompanyId);
  }

  const path = "/api/integrations/fleet/companies/" + encodeURIComponent(scope.companyId) +
    "/accounting-settings" +
    (scope.mapped ? "?sourceCompanyId=" + encodeURIComponent(scope.sourceCompanyId) : "");
  const result = await request(path);
  assertFinanceResponseScope(result, scope);
  return {
    fleetCashAccountId: Number(result.fleetCashAccountId) || null,
    fleetDriverReceivableAccountId: Number(result.fleetDriverReceivableAccountId) || null,
    journalId: Number(result.journalId) || null,
    ...(scope.mapped ? mappedIdentity(scope) : {}),
  };
}

export async function updateFleetAccountingSettings(args: {
  companyId: number;
  fleetCashAccountId: number;
  fleetDriverReceivableAccountId: number;
  journalId: number;
}) {
  assertCentralFinanceWriteEnabled();
  const scope = financeScope(args.companyId, true);
  const key = `fleet-accounting-settings:${args.companyId}:${args.fleetCashAccountId}:${args.fleetDriverReceivableAccountId}:${args.journalId}`;
  const result = await request(
    `/api/integrations/fleet/companies/${encodeURIComponent(scope.companyId)}/accounting-settings`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ ...args, ...mappedIdentity(scope) }),
    },
  );
  assertFinanceResponseScope(result, scope);
  return {
    ...mappedIdentity(scope),
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
  const scope = financeScope(args.companyId, true);
  const key = `fleet-cash-payment:${args.companyId}:${args.paymentId}`;
  const result = await request("/api/integrations/fleet/cash-payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ ...args, ...mappedIdentity(scope) }),
  });
  assertFinanceResponseScope(result, scope);
  const entryId = Number(result.entryId ?? result.accountingEntryId);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) throw new Error("Central Finance tidak mengembalikan accounting entry ID.");
  return { entryId, idempotent: Boolean(result.idempotent), ...mappedIdentity(scope) };
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
  const scope = financeScope(args.companyId, true);
  const key = `fleet-cash-payment-reversal:${args.companyId}:${args.paymentId}:${args.originalEntryId}`;
  const result = await request("/api/integrations/fleet/cash-payments/reverse", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ ...args, ...mappedIdentity(scope) }),
  });
  assertFinanceResponseScope(result, scope);
  const entryId = Number(result.entryId ?? result.accountingEntryId);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) throw new Error("Central Finance tidak mengembalikan reversal entry ID.");
  return { entryId, idempotent: Boolean(result.idempotent), ...mappedIdentity(scope) };
}
