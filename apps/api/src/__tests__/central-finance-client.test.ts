import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFleetAccountingSettings,
  postFleetCashPayment,
  reverseFleetCashPayment,
  updateFleetAccountingSettings,
} from "../lib/central-finance-client";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function enableFinance(writeEnabled = false) {
  process.env.CENTRAL_FINANCE_BASE_URL = "https://dev-bizportal.example.test";
  process.env.CENTRAL_FINANCE_SERVICE_TOKEN = "test-service-token";
  process.env.CENTRAL_FINANCE_WRITE_ENABLED = writeEnabled ? "true" : "false";
}

describe("Central Finance boundary", () => {
  it("reads canonical Fleet accounting settings with bearer auth", async () => {
    enableFinance(false);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://dev-bizportal.example.test/api/integrations/fleet/companies/1/accounting-settings");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-service-token");
      return new Response(JSON.stringify({
        fleetCashAccountId: 11,
        fleetDriverReceivableAccountId: 12,
        journalId: 13,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFleetAccountingSettings(1)).resolves.toEqual({
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
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("fleet-accounting-settings:1:11:12:13");
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify({
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
      return new Response(JSON.stringify({ entryId: keys.length, idempotent: false }), {
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
