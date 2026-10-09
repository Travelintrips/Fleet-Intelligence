import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { pool } from "../lib/db";
import { initializeProductionSessionSigning, isDevelopmentEnvironment, setProductionSessionCookie } from "./dev-auth";

const router = Router();
const CALLBACK = "https://fleet.cstlogistic.co.id/api/auth/google/callback";
const STATE_COOKIE = "fleet_google_oauth_state";
const ALLOWED_ROLES = new Set(["admin", "owner", "super_admin", "finance", "accounting"]);
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

function oauthConfig() {
  const clientId = String(process.env.FLEET_GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.FLEET_GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret || isDevelopmentEnvironment()) return null;
  return { clientId, clientSecret };
}
function loginRedirect(reason: string) {
  return "/logistics/fleet-intelligence?google_error=" + encodeURIComponent(reason);
}
router.get("/auth/google/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: Boolean(oauthConfig()) });
});
router.get("/auth/google/start", (_req, res) => {
  const config = oauthConfig();
  if (!config) { res.redirect(loginRedirect("Google Login belum diaktifkan.")); return; }
  const state = randomBytes(32).toString("hex");
  res.append("Set-Cookie", `${STATE_COOKIE}=${state}; Max-Age=600; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax`);
  res.setHeader("Cache-Control", "no-store");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", CALLBACK);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  res.redirect(url.toString());
});
router.get("/auth/google/callback", async (req, res) => {
  res.append("Set-Cookie", `${STATE_COOKIE}=; Max-Age=0; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax`);
  res.setHeader("Cache-Control", "no-store");
  const config = oauthConfig();
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookieValue = (req.headers.cookie ?? "").split(";").map(v => v.trim())
    .find(v => v.startsWith(STATE_COOKIE + "="))?.slice(STATE_COOKIE.length + 1) ?? "";
  const expected = Buffer.from(cookieValue);
  const supplied = Buffer.from(state);
  if (!config || !state || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    res.redirect(loginRedirect("Sesi Google tidak valid. Silakan ulangi login.")); return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) { res.redirect(loginRedirect("Google tidak memberikan kode otorisasi.")); return; }
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId, client_secret: config.clientSecret,
        code, grant_type: "authorization_code", redirect_uri: CALLBACK,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!tokenResponse.ok) throw new Error("Token exchange failed");
    const token = await tokenResponse.json() as { id_token?: string };
    if (!token.id_token) throw new Error("Missing identity token");
    const verifyResponse = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token.id_token), {
      signal: AbortSignal.timeout(12000),
    });
    if (!verifyResponse.ok) throw new Error("Identity verification failed");
    const identity = await verifyResponse.json() as {
      aud?: string; iss?: string; email?: string; email_verified?: string | boolean; sub?: string; exp?: string;
    };
    const email = String(identity.email ?? "").trim().toLowerCase();
    if (identity.aud !== config.clientId || !GOOGLE_ISSUERS.has(String(identity.iss)) ||
      identity.email_verified !== true && identity.email_verified !== "true" ||
      !identity.sub || !email || Number(identity.exp ?? 0) * 1000 <= Date.now()) {
      throw new Error("Unverified Google identity");
    }
    const account = await pool.query<{ id: string; email: string; role: string; is_active: boolean; status: string | null }>(
      `SELECT id::text,email,role,COALESCE(is_active,false) AS is_active,status
         FROM public.users WHERE lower(email)=$1 LIMIT 1`,
      [email],
    );
    const user = account.rows[0];
    if (!user || !user.is_active || !ALLOWED_ROLES.has(String(user.role ?? "").toLowerCase()) ||
      user.status && user.status.toLowerCase() !== "active") {
      res.redirect(loginRedirect("Akun Google belum memiliki akses CST Fleet.")); return;
    }
    await initializeProductionSessionSigning();
    const now = Date.now();
    setProductionSessionCookie(res, { id: user.id, email, issuedAt: now, expiresAt: now + 8 * 60 * 60 * 1000 });
    res.redirect("/logistics/fleet-intelligence");
  } catch (error) {
    req.log.warn({ error }, "Google sign-in failed");
    res.redirect(loginRedirect("Login Google gagal. Silakan gunakan email dan password."));
  }
});
export default router;
