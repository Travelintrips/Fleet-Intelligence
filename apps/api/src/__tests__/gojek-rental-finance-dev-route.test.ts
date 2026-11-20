import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const start = src.indexOf('router.get("/accounting/gojek-rental/preview"');
const end = src.indexOf('router.get("/accounting/journals"', start);
const route = src.slice(start, end);

describe("Gojek rental DEV preview route is authenticated, source-bound and never posts", () => {
  it("is DEV-only and restricts Company 1 source with a company-scoped DB query", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(route).toContain('process.env.APP_ENV !== "development"');
    expect(route).toContain('cid !== 1');
    expect(route).toContain("WHERE company_id=$1 AND id=ANY($2::int[])");
    expect(route).toContain("[cid,ids]");
    expect(route).toContain("Sumber transaksi Gojek tidak lengkap");
  });
  it("does not accept arbitrary IDs or unverified categories and never posts", () => {
    expect(route).toContain('ids.length > 20');
    expect(route).toContain('new Set(ids).size !== ids.length');
    expect(route).toContain('deduplicateGojekRentalPreviews(events)');
    expect(route).toContain('postingAllowed: false');
    expect(route).toContain('approvalRequired: true');
    expect(route).toContain('"private, no-store"');
    expect(route).not.toMatch(/INSERT INTO|UPDATE public|DELETE FROM public|postFleetCashPayment\(/);
  });
});
