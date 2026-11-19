import { describe, expect, it } from "vitest";
import { canManageDivaTax } from "../lib/fleet-diva-staff-authorization";
import type { DevAuthUser } from "../routes/dev-auth";
const user = (role: string, email = "staff@example.com", companyId: number | null = 1): DevAuthUser => ({
  id: "signed-test-user", email, role, companyId, firstName: null, lastName: null,
});
describe("Diva tax delegated staff access", () => {
  it("retains existing owner and super-admin authorization for Company 1", () => {
    expect(canManageDivaTax(user("owner"))).toBe(true);
    expect(canManageDivaTax(user("super_admin"))).toBe(true);
  });
  it("does not grant every admin access by default", () => {
    expect(canManageDivaTax(user("admin"), "")).toBe(false);
    expect(canManageDivaTax(user("admin"), "other@example.com")).toBe(false);
  });
  it("permits only explicitly assigned admin email", () => {
    expect(canManageDivaTax(user("admin", "STAFF@example.com"), "other@example.com, staff@example.com")).toBe(true);
    expect(canManageDivaTax(user("admin", "notstaff@example.com"), "staff@example.com")).toBe(false);
  });
  it("rejects Finance/Accounting and other company even when email is listed", () => {
    expect(canManageDivaTax(user("finance"), "staff@example.com")).toBe(false);
    expect(canManageDivaTax(user("accounting"), "staff@example.com")).toBe(false);
    expect(canManageDivaTax(user("admin", "staff@example.com", 3), "staff@example.com")).toBe(false);
    expect(canManageDivaTax(undefined, "staff@example.com")).toBe(false);
  });
});
