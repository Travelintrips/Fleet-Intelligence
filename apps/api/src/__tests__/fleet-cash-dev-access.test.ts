import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
import { requireFleetCashDevAccess } from "../lib/fleet-cash-dev-access";
const original = { ...process.env };
const origin = "https://dev-fleet.cstlogistic.co.id";
beforeEach(() => Object.assign(process.env, { APP_ENV: "development", APP_BASE_URL: origin, FLEET_DEV_GOOGLE_AUTH_ENABLED: "true", FLEET_CASH_DATABASE_ENABLED_DEV: "true" }));
afterEach(() => { process.env = { ...original }; });
function call(changes: Record<string, unknown> = {}) {
  const req = { method: "POST", secure: true, hostname: "dev-fleet.cstlogistic.co.id", adminUser: { role: "super_admin", companyId: 1 }, body: {}, get: () => origin, ...changes };
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  const next = vi.fn();
  requireFleetCashDevAccess(req as never, res as never, next);
  return { res, next };
}
describe("Cash DEV boundary after existing signed-session authentication", () => {
  it("accepts only the configured Google Super Admin source scope and browser origin", () => {
    const { next, res } = call(); expect(next).toHaveBeenCalledOnce(); expect(res.status).not.toHaveBeenCalled();
  });
  it.each([
    { adminUser: { role: "admin", companyId: 1 } },
    { adminUser: { role: "super_admin", companyId: 3 } },
    { adminUser: undefined }, { secure: false }, { hostname: "fleet.cstlogistic.co.id" },
    { get: () => "https://other.invalid" }, { body: { company_id: 3 } },
    { body: { companyId: 3 } }, { body: { sourceCompanyId: 3 } },
  ])("rejects an invalid identity/origin/scope before the cash handler", (changes) => {
    const { res, next } = call(changes); expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
  it("does not admit legacy DEV sessions if Google mode is disabled", () => {
    process.env.FLEET_DEV_GOOGLE_AUTH_ENABLED = "false";
    expect(call().res.status).toHaveBeenCalledWith(403);
  });
  it("leaves inactive DEV cash routes closed", () => {
    process.env.FLEET_CASH_DATABASE_ENABLED_DEV = "false";
    expect(call().res.status).toHaveBeenCalledWith(409);
  });
  it("does not alter the existing production authentication contract", () => {
    process.env.APP_ENV = "production";
    expect(call({ hostname: "fleet.cstlogistic.co.id" }).next).toHaveBeenCalledOnce();
  });
});
