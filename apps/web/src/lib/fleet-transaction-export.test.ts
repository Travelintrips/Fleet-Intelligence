import { describe, expect, it, vi } from "vitest";
import { buildFleetTransactionsCsv, getAllFilteredFleetTransactions } from "./fleet-transaction-export";

function rows(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    id: index + 1,
    transaction_date: "2026-11-04",
    driver_name: "DRIVER TEST",
    vehicle_plate: "B 1234 ZZ",
    service_type: "Rental fee due",
    trip_count: 0,
    gross_revenue: 1000,
    incentive: 0,
    commission: 0,
    deduction: 0,
    net_revenue: 1000,
    outstanding_balance: 0,
    ppn_rate: 0,
    ppn_amount: 0,
  }));
}
const filters = {
  startDate: "2026-11-01",
  endDate: "2026-11-04",
  driverSearch: "DRIVER",
  vehiclePlate: "B 1234",
};
const reply = (transactions: unknown[], total: number, status = 200) =>
  new Response(JSON.stringify({ transactions, summary: { total } }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Fleet Transactions CSV export: full company-scoped active filter", () => {
  it("fetches all 413 eligible records, not just 25 visible; API limit=200", async () => {
    const data = rows(413);
    const requester = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const params = new URL(String(url), "https://dev-fleet.cstlogistic.co.id").searchParams;
      expect(init?.credentials).toBe("include");
      expect(init?.cache).toBe("no-store");
      expect(params.get("limit")).toBe("200");
      expect(params.get("startDate")).toBe("2026-11-01");
      expect(params.get("endDate")).toBe("2026-11-04");
      expect(params.get("driverSearch")).toBe("DRIVER");
      expect(params.get("vehiclePlate")).toBe("B 1234");
      const page = Number(params.get("page"));
      const start = (page - 1) * 200;
      return reply(data.slice(start, start + 200), data.length);
    });
    const exported = await getAllFilteredFleetTransactions(filters, requester as typeof fetch);
    expect(exported).toHaveLength(413);
    expect(new Set(exported.map(x => x.id)).size).toBe(413);
    expect(requester).toHaveBeenCalledTimes(3);
    const csv = buildFleetTransactionsCsv(exported, true);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(414); // header + every eligible row
    expect(csv).toContain('"Tagihan Sewa"');
    expect(csv).toContain('"Nilai Biaya Sewa"');
    expect(csv).not.toContain('"Net Revenue"');
  });

  it("stops if a later page returns HTTP 401; never exports first 200 alone", async () => {
    const data = rows(413);
    const requester = vi.fn(async (url: RequestInfo | URL) => {
      const page = Number(new URL(String(url), "https://dev-fleet.cstlogistic.co.id").searchParams.get("page"));
      return page === 1 ? reply(data.slice(0, 200), 413) : reply([], 413, 401);
    });
    await expect(getAllFilteredFleetTransactions(filters, requester as typeof fetch))
      .rejects.toThrow(/HTTP 401/);
    expect(requester).toHaveBeenCalledTimes(2);
  });

  it("rejects a changing total between pages instead of silently truncating", async () => {
    const data = rows(413);
    const requester = vi.fn(async (url: RequestInfo | URL) => {
      const page = Number(new URL(String(url), "https://dev-fleet.cstlogistic.co.id").searchParams.get("page"));
      return reply(data.slice((page - 1) * 200, page * 200), page === 1 ? 413 : 414);
    });
    await expect(getAllFilteredFleetTransactions(filters, requester as typeof fetch))
      .rejects.toThrow(/Jumlah transaksi berubah/);
  });

  it("rejects duplicates across pages and missing rows", async () => {
    const data = rows(413);
    const duplicate = vi.fn(async (url: RequestInfo | URL) => {
      const page = Number(new URL(String(url), "https://dev-fleet.cstlogistic.co.id").searchParams.get("page"));
      return reply(page === 1 ? data.slice(0, 200) : data.slice(199, 399), 413);
    });
    await expect(getAllFilteredFleetTransactions(filters, duplicate as typeof fetch))
      .rejects.toThrow(/duplikat/);

    const missing = vi.fn(async (url: RequestInfo | URL) => {
      const page = Number(new URL(String(url), "https://dev-fleet.cstlogistic.co.id").searchParams.get("page"));
      return reply(page === 1 ? data.slice(0, 200) : [], 413);
    });
    await expect(getAllFilteredFleetTransactions(filters, missing as typeof fetch))
      .rejects.toThrow(/Sebagian transaksi gagal/);
  });

  it("fails closed above the explicit 20,000-row safety cap", async () => {
    const requester = vi.fn(async () => reply(rows(1), 20_001));
    await expect(getAllFilteredFleetTransactions(filters, requester as typeof fetch))
      .rejects.toThrow(/batas aman/);
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("escapes quotes and spreadsheet formulas only in user-supplied text fields", () => {
    const record = {
      id: 1,
      transaction_date: "2026-11-04",
      driver_name: '=HYPERLINK("https://invalid.example","click")',
      vehicle_plate: '+SUM(1,2)',
      service_type: "@CMD",
      trip_count: 0,
      gross_revenue: 0,
      incentive: 0,
      commission: 0,
      deduction: -123,
      net_revenue: -123,
      outstanding_balance: 0,
      ppn_rate: 0,
      ppn_amount: 0,
    };
    const csv = buildFleetTransactionsCsv([record], true);
    expect(csv).toContain('"' + "'=HYPERLINK(" + '""https://invalid.example""');
    expect(csv).toContain(`"'+SUM(1,2)"`);
    expect(csv).toContain(`"'@CMD"`);
    expect(csv).toContain('"-123"'); // signed monetary values stay numeric
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});
