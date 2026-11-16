/** Verified Supabase Google user, used only for restricted CST Fleet DEV sign-in.
 * The user lookup MUST come from GoTrue /auth/v1/user, never from JWT payload
 * metadata or user-supplied JSON. The JWT expiry/AMR helper only adds restrictions
 * after GoTrue has independently verified the signed bearer token.
 */
export interface FleetDevGoogleIdentity {
  id: string;
  email: string;
  role: "super_admin";
  companyId: 1;
  canonicalUserId: string;
}

type IdentityConfig = { allowedAuthId: string; allowedCanonicalId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function trustedFleetDevGoogleIdentity(
  candidate: unknown,
  options: IdentityConfig,
): FleetDevGoogleIdentity | null {
  if (!candidate || typeof candidate !== "object" ||
      !UUID.test(options.allowedAuthId) ||
      !PROFILE_ID.test(options.allowedCanonicalId)) return null;
  const user = candidate as Record<string, unknown>;
  const app = user.app_metadata;
  if (!app || typeof app !== "object") return null;
  const meta = app as Record<string, unknown>;
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (typeof user.id !== "string" || user.id !== options.allowedAuthId ||
      !email || email.length > 320 || !email.includes("@") ||
      typeof user.email_confirmed_at !== "string" || !user.email_confirmed_at) return null;
  const identities = Array.isArray(user.identities) ? user.identities : [];
  const googleLinked = meta.provider === "google" ||
    (Array.isArray(meta.providers) && meta.providers.includes("google")) ||
    identities.some((x) => x && typeof x === "object" &&
      (x as Record<string, unknown>).provider === "google");
  if (!googleLinked || meta.ai_task_user_id !== options.allowedCanonicalId ||
      meta.ai_task_role !== "super_admin" ||
      meta.ai_task_company_id !== "@NULL@") return null;
  return {
    id: user.id,
    email,
    role: "super_admin",
    companyId: 1,
    canonicalUserId: options.allowedCanonicalId,
  };
}

/** Decode expiry only AFTER the GoTrue /user API verifies the signed token. */
export function verifiedGoogleOAuthExpiry(accessToken: string, now = Date.now()): number | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
      amr?: unknown;
      aud?: unknown;
    };
    const oauth = Array.isArray(claims.amr) && claims.amr.some((entry) =>
      entry && typeof entry === "object" &&
      (entry as Record<string, unknown>).method === "oauth");
    if (!oauth || claims.aud !== "authenticated" ||
        typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp)) return null;
    const expiration = claims.exp * 1000;
    if (expiration <= now || expiration > now + 7 * 24 * 60 * 60 * 1000) return null;
    return expiration;
  } catch {
    return null;
  }
}
