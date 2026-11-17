import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db", () => ({
  pool: { query: vi.fn() },
}));
import { pool } from "../lib/db";
import {
  getFleetAccountingSettings,
  postFleetCashPayment,
  reverseFleetCashPayment,
  updateFleetAccountingSettings,
} from "../lib/central-finance-client";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.FLEET_FINANCE_COMPANY_MAP;
  vi.mocked(pool.query).mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function enableFinance(writeEnabled = false) {
  process.env.CENTRAL_FINANCE_BASE_URL = "https://dev-bizportal.example.test";
  process.env.CENTRAL_FINANCE_SERVICE_TOKEN = "test-service-token";
  process.env.CENTRAL_FINANCE_WRITE_ENABLED = writeEnabled ? "true" : "false";
  process.env.FLEET_FINANCE_COMPANY_MAP = '{"1":3}';
}

describe("Central Finance boundary", () => {
  it("reads canonical Fleet accounting settings with bearer auth", async () => {
    enableFinance(false);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://dev-bizportal.example.test/api/integrations/fleet/companies/3/accounting-settings?sourceCompanyId=1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-service-token");
      return new Response(JSON.stringify({
        companyId: 3,
        sourceCompanyId: 1,
        fleetCashAccountId: 11,
        fleetDriverReceivableAccountId: 12,
        journalId: 13,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFleetAccountingSettings(1)).resolves.toEqual({
      companyId: 3,
      sourceCompanyId: 1,
      fleetCashAccountId: 11,
      fleetDriverReceivableAccountId: 12,
      journalId: 13,
    });
  });

  it("blocks settings writes while Central Finance write mode is disabled", async () => {
    enableFinance(false);
    await expect(updateFleetAccountingSettings({
      companyId: 1,
      fleetCashAccountId: 11,
      fleetDriverReceivableAccountId: 12,
      journalId: 13,
    })).rejects.toThrow("Posting Central Finance dari Fleet belum diaktifkan");
  });

  it("uses deterministic idempotency key for settings updates", async () => {
    enableFinance(true);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://dev-bizportal.example.test/api/integrations/fleet/companies/3/accounting-settings");
      expect(JSON.parse(String(init?.body))).toMatchObject({ companyId: 3, sourceCompanyId: 1 });
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("fleet-accounting-settings:1:11:12:13");
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify({
        companyId: 3,
        sourceCompanyId: 1,
        fleetCashAccountId: 11,
        fleetDriverReceivableAccountId: 12,
        journalId: 13,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateFleetAccountingSettings({
      companyId: 1,
      fleetCashAccountId: 11,
      fleetDriverReceivableAccountId: 12,
      journalId: 13,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses deterministic idempotency keys for payment and reversal writes", async () => {
    enableFinance(true);
    const keys: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      expect(JSON.parse(String(init?.body))).toMatchObject({ companyId: 3, sourceCompanyId: 1, paymentId: 99 });
      return new Response(JSON.stringify({ entryId: keys.length, idempotent: false, companyId: 3, sourceCompanyId: 1 }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await postFleetCashPayment({
      companyId: 1,
      paymentId: 99,
      amount: 50000,
      driverName: "Test Driver",
      paymentDate: "2026-10-05",
    });
    await reverseFleetCashPayment({
      companyId: 1,
      paymentId: 99,
      originalEntryId: 1,
      amount: 50000,
      driverName: "Test Driver",
    });

    expect(keys).toEqual([
      "fleet-cash-payment:1:99",
      "fleet-cash-payment-reversal:1:99:1",
    ]);
  });

  it("propagates Central Finance errors without leaking service token", async () => {
    enableFinance(true);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "COA Fleet tidak valid." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    ));

    await expect(postFleetCashPayment({
      companyId: 1,
      paymentId: 99,
      amount: 50000,
      driverName: "Test Driver",
      paymentDate: "2026-10-05",
    })).rejects.toThrow("COA Fleet tidak valid.");
  });
});

const sourcePayment = {
  companyId: 1,
  paymentId: 99,
  amount: 50000,
  driverName: "Test Driver",
  paymentDate: "2026-10-05",
};
const sourceReversal = { ...sourcePayment, originalEntryId: 101 };
const sourceSettings = {
  companyId: 1,
  fleetCashAccountId: 11,
  fleetDriverReceivableAccountId: 12,
  journalId: 13,
};
function financeResponse(extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    companyId: 3, sourceCompanyId: 1,
    fleetCashAccountId: 11, fleetDriverReceivableAccountId: 12, journalId: 13,
    entryId: 101, idempotent: false, ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("explicit Fleet source to Diva Finance mapping", () => {
  it("keeps map-absent read-only API behavior within the source company", async () => {
    enableFinance(false);
    delete process.env.FLEET_FINANCE_COMPANY_MAP;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://dev-bizportal.example.test/api/integrations/fleet/companies/1/accounting-settings");
      return financeResponse({ companyId: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await getFleetAccountingSettings(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("keeps legacy direct reads source-scoped only when mapping and writes are absent", async () => {
    enableFinance(false);
    delete process.env.FLEET_FINANCE_COMPANY_MAP;
    delete process.env.CENTRAL_FINANCE_BASE_URL;
    delete process.env.CENTRAL_FINANCE_SERVICE_TOKEN;
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ fleet_cash_account_id: 11, fleet_driver_receivable_account_id: 12, journal_id: 13 }],
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getFleetAccountingSettings(1)).resolves.toEqual({
      fleetCashAccountId: 11, fleetDriverReceivableAccountId: 12, journalId: 13,
    });
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [1]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["CENTRAL_FINANCE_BASE_URL", "CENTRAL_FINANCE_SERVICE_TOKEN"])(
    "never falls back to either company's DB for mapped reads when %s is absent",
    async (variable) => {
      enableFinance(false);
      delete process.env[variable];
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(getFleetAccountingSettings(1)).rejects.toThrow("API wajib");
      expect(pool.query).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fails before any remote or local access when writes are enabled without a mapping", async () => {
    enableFinance(true);
    delete process.env.FLEET_FINANCE_COMPANY_MAP;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const run of [
      () => getFleetAccountingSettings(1),
      () => updateFleetAccountingSettings(sourceSettings),
      () => postFleetCashPayment(sourcePayment),
      () => reverseFleetCashPayment(sourceReversal),
    ]) {
      await expect(run()).rejects.toThrow("Mapping perusahaan Fleet Finance belum dikonfigurasi");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects writes while disabled before examining mapping or accessing any service", async () => {
    enableFinance(false);
    process.env.FLEET_FINANCE_COMPANY_MAP = "invalid json";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const run of [
      () => updateFleetAccountingSettings(sourceSettings),
      () => postFleetCashPayment(sourcePayment),
      () => reverseFleetCashPayment(sourceReversal),
    ]) {
      await expect(run()).rejects.toThrow("Posting Central Finance dari Fleet belum diaktifkan");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    "not-json", "null", "[]", "{}", '{"1":"3"}', '{"1":0}', '{"1":-3}',
    '{"1":3.5}', '{"01":3}', '{"0":3}', '{"-1":3}', '{"1.5":3}',
    '{"9007199254740992":3}', '{"1":9007199254740992}', '{"1":3,"2":null}',
  ])("rejects malformed mapping %s before I/O", async (mapping) => {
    enableFinance(true);
    process.env.FLEET_FINANCE_COMPANY_MAP = mapping;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(postFleetCashPayment(sourcePayment)).rejects.toThrow("Mapping perusahaan Fleet Finance tidak valid");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects an unmapped source and never interprets the target as the source", async () => {
    enableFinance(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getFleetAccountingSettings(2)).rejects.toThrow("tidak memiliki mapping");
    await expect(postFleetCashPayment({ ...sourcePayment, companyId: 3 })).rejects.toThrow("tidak memiliki mapping");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid source company %s before I/O",
    async (companyId) => {
      enableFinance(true);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(postFleetCashPayment({ ...sourcePayment, companyId })).rejects.toThrow("sumber Fleet tidak valid");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["settings read", () => getFleetAccountingSettings(1)],
    ["settings update", () => updateFleetAccountingSettings(sourceSettings)],
    ["payment", () => postFleetCashPayment(sourcePayment)],
    ["reversal", () => reverseFleetCashPayment(sourceReversal)],
  ] as const)("rejects wrong or missing response identity for %s", async (_label, run) => {
    enableFinance(true);
    for (const responseIdentity of [
      { companyId: 1, sourceCompanyId: 1 },
      { companyId: 3, sourceCompanyId: 3 },
      { companyId: undefined, sourceCompanyId: 1 },
      { companyId: 3, sourceCompanyId: undefined },
      { companyId: "3", sourceCompanyId: "1" },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => financeResponse(responseIdentity)));
      await expect(run()).rejects.toThrow("Respons Central Finance tidak sesuai");
    }
  });

  it("keeps the source payment immutable and replays the same source-based event key", async () => {
    enableFinance(true);
    const payment = Object.freeze({ ...sourcePayment });
    const requests: Array<{ body: Record<string, unknown>; key: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        key: new Headers(init?.headers).get("Idempotency-Key") ?? "",
      });
      return financeResponse({ idempotent: requests.length > 1 });
    }));
    await expect(postFleetCashPayment(payment)).resolves.toMatchObject({
      companyId: 3, sourceCompanyId: 1, entryId: 101, idempotent: false,
    });
    await expect(postFleetCashPayment(payment)).resolves.toMatchObject({
      companyId: 3, sourceCompanyId: 1, entryId: 101, idempotent: true,
    });
    expect(payment.companyId).toBe(1);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].key).toBe("fleet-cash-payment:1:99");
    expect(requests[0].body).toMatchObject({ companyId: 3, sourceCompanyId: 1 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not mark a payment successful for invalid journal entry %s",
    async (entryId) => {
      enableFinance(true);
      vi.stubGlobal("fetch", vi.fn(async () => financeResponse({ entryId })));
      await expect(postFleetCashPayment(sourcePayment)).rejects.toThrow("accounting entry ID");
    },
  );
});
