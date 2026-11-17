import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This is a scoped regression contract. The exact SQL was also verified
// against the 425-row official source import on CST-DEV using read-only SQL.
const api = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const page = readFileSync(resolve(process.cwd(), "../web/src/pages/transactions.tsx"), "utf8");
const csvExport = readFileSync(resolve(process.cwd(), "../web/src/lib/fleet-transaction-export.ts"), "utf8");
const route = api.split('router.get("/transactions"')[1]?.split('router.get("/drivers"')[0];

describe("Fleet DEV rental fee source integrity and eligibility visibility", () => {
  it("keeps active-driver eligibility unchanged and counts excluded historical transactions", () => {
    expect(route).toBeDefined();
    expect(route).toContain("d.status='active'");
    expect(route).toContain("COALESCE(d.source_present_in_latest_snapshot,true)=true");
    expect(route).toContain("const sourceCount = await pool.query");
    expect(route).toContain("WHERE company_id=$1");
    expect(route).toContain("AND ($2::date IS NULL OR transaction_date >= $2::date)");
    expect(route).toContain("AND ($3::date IS NULL OR transaction_date <= $3::date)");
    expect(route).toContain("AND ($4='' OR COALESCE(driver_name,'') ILIKE '%' || $4 || '%'");
    expect(route).toContain("AND ($5='' OR COALESCE(vehicle_plate,'') ILIKE '%' || $5 || '%')");
    expect(route).toContain("Math.max(0, totalFilteredRows - normalizedRows)");
    expect(route).toContain("excludedByEligibility,");
    expect(route).toContain("totalFilteredRows,");
  });

  it("distinguishes Gojek rental fee due/deduction from trip revenue without rewriting amounts", () => {
    expect(route).toContain("AS rental_fee_rows");
    expect(route).toContain("AS rental_fee_signed_net");
    expect(route).toContain("AS rental_fee_due_total");
    expect(route).toContain("AS rental_fee_deduction_total");
    expect(route).toContain("transaction_type IN ('Rental fee due','Rental fee deduction')");
    // Existing actual transactions remain returned, not reclassified in SQL.
    expect(route).toContain("transactions: rows.rows");
    expect(route).toContain("SUM(net_revenue)");
  });

  it("shows company-scoped source date coverage without claiming a fresh Gojek feed", () => {
    expect(route).toContain("MIN(transaction_date)::text AS first_available_date");
    expect(route).toContain("MAX(transaction_date)::text AS last_available_date");
    expect(route).toContain("const totalStoredRows =");
    expect(route).toContain("firstAvailableDate:");
    expect(route).toContain("lastAvailableDate:");
    expect(route).toContain('state: totalStoredRows > 0 ? "normalized"');
    expect(page).toContain("Periode data tersimpan:");
    expect(page).toContain("lastAvailableDate");
    expect(page).toContain("bukan bukti bahwa tidak ada transaksi");
    expect(page).toContain("Ini tidak berarti tidak ada transaksi lebih baru di sumber Gojek");
    expect(page).toContain("if (!res.ok) throw new Error");
  });

  it("surfaces excluded rows and explicitly relabels fee-only totals and CSV headers", () => {
    expect(page).toContain("excludedByEligibility ?? 0");
    expect(page).toContain("tidak tampil sebagai transaksi driver aktif");
    expect(page).toContain("tidak diaktifkan otomatis");
    expect(page).toContain("feeLedgerOnly");
    expect(page).toContain("bukan pendapatan perjalanan GoCar");
    expect(page).toContain("Pergerakan Biaya Sewa Bersih");
    expect(page).toContain("Tagihan Biaya Sewa");
    expect(page).toContain("buildFleetTransactionsCsv(rows, feeLedgerOnly)");
    expect(csvExport).toContain('feeLedgerOnly ? "Tagihan Sewa" : "Gross Revenue"');
    expect(csvExport).toContain('feeLedgerOnly ? "Nilai Biaya Sewa" : "Net Revenue"');
  });
});
