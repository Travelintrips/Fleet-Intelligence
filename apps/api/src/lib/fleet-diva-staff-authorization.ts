import type { DevAuthUser } from "../routes/dev-auth";

/**
 * All Diva tax access is delegated to signed-in existing Fleet accounts.
 * Cross-company staff can be explicitly assigned only by exact email and
 * still use the dedicated Company-3 tax-only database role and audit path.
 * No operational Fleet, Gojek, WA or Finance privilege is granted here.
 */
export function canManageDivaTax(
  user: DevAuthUser | undefined,
  staffEmails = process.env.FLEET_DIVA_TAX_STAFF_EMAILS_PROD ?? "",
): boolean {
  if (!user) return false;
  const role = String(user.role ?? "").trim().toLowerCase();
  const companyId = Number(user.companyId);
  const isCompanyOneOwner = companyId === 1 && (role === "owner" || role === "super_admin");
  if (isCompanyOneOwner) return true;
  if (role !== "admin" && role !== "super_admin") return false;
  if (!Number.isInteger(companyId) || ![1, 4].includes(companyId)) return false;
  const email = String(user.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return false;
  return staffEmails.split(",").map(value => value.trim().toLowerCase()).filter(Boolean).includes(email);
}
