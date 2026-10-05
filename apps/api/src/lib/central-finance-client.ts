type Json = Record<string, unknown>;

function required(value: unknown, name: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${name} belum dikonfigurasi.`);
  return v;
}

function clientConfig() {
  return {
    baseUrl: required(process.env.CENTRAL_FINANCE_BASE_URL, "CENTRAL_FINANCE_BASE_URL").replace(/\/$/, ""),
    token: required(process.env.CENTRAL_FINANCE_SERVICE_TOKEN, "CENTRAL_FINANCE_SERVICE_TOKEN"),
    writeEnabled: String(process.env.CENTRAL_FINANCE_WRITE_ENABLED ?? "false").toLowerCase() === "true",
  };
}

async function request(path: string, init: RequestInit = {}): Promise<Json> {
  const cfg = clientConfig();
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

function assertWriteEnabled() {
  if (String(process.env.CENTRAL_FINANCE_WRITE_ENABLED ?? "false").toLowerCase() !== "true") {
    throw new Error("Posting Central Finance dari Fleet belum diaktifkan.");
  }
}

export async function getFleetAccountingSettings(companyId: number) {
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
  assertWriteEnabled();
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
  assertWriteEnabled();
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
  assertWriteEnabled();
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
