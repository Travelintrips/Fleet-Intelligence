import { describe, expect, it } from "vitest";
import { canManageDivaTax } from "../lib/fleet-diva-staff-authorization";
import type { DevAuthUser } from "../routes/dev-auth";
const user = (role: string, email = "staff@example.com", companyId: number | null = 1): DevAuthUser => ({
  id: "signed-test-user", email, role, companyId, firstName: null, lastName: null,
});
const assigned = "admcst001@gmail.com, almanosetiawan@gmail.com, divatranssoetta@gmail.com, abing2267@gmail.com";
describe("Diva tax delegated staff access", () => {
  it("retains original Company-1 owner/super-admin access", () => {
    expect(canManageDivaTax(user("owner", "admcst001@gmail.com"), assigned)).toBe(true);
    expect(canManageDivaTax(user("super_admin", "owner@example.com"), "")).toBe(true);
  });
  it("supports the four explicitly selected real Fleet roles/company scopes", () => {
    expect(canManageDivaTax(user("admin", "almanosetiawan@gmail.com", 1), assigned)).toBe(true);
    expect(canManageDivaTax(user("admin", "divatranssoetta@gmail.com", 4), assigned)).toBe(true);
    expect(canManageDivaTax(user("super_admin", "abing2267@gmail.com", 4), assigned)).toBe(true);
  });
  it("does not allow unrelated admins or wildcard company-wide elevation", () => {
    expect(canManageDivaTax(user("admin", "erlanggaerix@gmail.com"), assigned)).toBe(false);
    expect(canManageDivaTax(user("admin", "other@example.com", 4), assigned)).toBe(false);
    expect(canManageDivaTax(user("super_admin", "other@example.com", 4), assigned)).toBe(false);
    expect(canManageDivaTax(user("owner", "other@example.com", 4), assigned)).toBe(false);
    expect(canManageDivaTax(user("admin", "almanosetiawan@gmail.com"), "")).toBe(false);
  });
  it("rejects non-admin roles and other company IDs even when email is listed", () => {
    expect(canManageDivaTax(user("finance", "almanosetiawan@gmail.com"), assigned)).toBe(false);
    expect(canManageDivaTax(user("accounting", "almanosetiawan@gmail.com"), assigned)).toBe(false);
    expect(canManageDivaTax(user("super_admin", "diva@admin.com", 3), assigned + ",diva@admin.com")).toBe(false);
    expect(canManageDivaTax(user("admin", "divatranssoetta@gmail.com", 3), assigned)).toBe(false);
    expect(canManageDivaTax(undefined, assigned)).toBe(false);
  });
});
