import type { DevAuthUser } from "../routes/dev-auth";

/**
 * Delegate only the isolated Company-3 Diva tax workflow to explicitly selected
 * Fleet staff. This never grants generic Fleet, Gojek or Finance permissions.
 * Company-1 scope reflects the existing signed Fleet operations session.
 */
export function canManageDivaTax(user: DevAuthUser | undefined, staffEmails = process.env.FLEET_DIVA_TAX_STAFF_EMAILS_PROD ?? ""): boolean {
  if (!user || Number(user.companyId) !== 1) return false;
  const role = String(user.role ?? "").trim().toLowerCase();
  if (role === "owner" || role === "super_admin") return true;
  if (role !== "admin") return false;
  const email = String(user.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return false;
  return staffEmails.split(",").map(value => value.trim().toLowerCase()).filter(Boolean).includes(email);
}
