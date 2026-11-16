import crypto from "node:crypto";
import { trustedFleetDevGoogleIdentity, verifiedGoogleOAuthExpiry } from "../lib/fleet-dev-google-identity";
import { Router, type Request, type Response } from "express";
import {
  getRuntimeDatabaseUrl,
  pool,
} from "../lib/db";

export interface DevAuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  companyId: number | null;
}

interface DevSession extends DevAuthUser {
  issuedAt: number;
  expiresAt: number;
}

export interface ProductionSession {
  id: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
}

const DEV_SESSION_COOKIE = "fleet_dev_session";
const PRODUCTION_SESSION_COOKIE = "fleet_session";
const DEV_SESSION_TTL_SECONDS = 8 * 60 * 60;
const FLEET_DEV_GOOGLE_COOKIE = "fleet_dev_google_session";
const FLEET_DEV_GOOGLE_ORIGIN = "https://dev-fleet.cstlogistic.co.id";
const FLEET_DEV_GOOGLE_SUPABASE_URL = "https://xssrfshdrtdfupgqwfdw.supabase.co";
const FLEET_DEV_GOOGLE_SESSION_MS = 30 * 60 * 1000;


export function isDevelopmentEnvironment(): boolean {
  const appEnvironment = process.env.APP_ENV?.trim().toLowerCase();
  const nodeEnvironment = process.env.NODE_ENV?.trim().toLowerCase();

  if (appEnvironment !== undefined) {
    return appEnvironment === "development";
  }

  return nodeEnvironment === "development";
}

let initializedProductionSessionSecret: string | null = null;
let productionSessionInitialization: Promise<void> | null = null;

function deriveProductionSessionSecret(databaseCredential: string): string {
  return crypto
    .createHash("sha256")
    .update("cst-fleet-intelligence:production-session:v1\0", "utf8")
    .update(databaseCredential, "utf8")
    .digest("hex");
}

function getExplicitSessionSecret(): string | null {
  for (const candidate of [
    process.env.FLEET_SESSION_SECRET,
    process.env.SESSION_SECRET,
    process.env.BIZPORTAL_SESSION_SECRET,
  ]) {
    const explicitSecret = candidate?.trim();
    if (explicitSecret && explicitSecret.length >= 32) return explicitSecret;
  }
  return null;
}

function getSessionSecret(): string | null {
  return getExplicitSessionSecret() ?? initializedProductionSessionSecret;
}

function isFleetDevGoogleMode(): boolean {
  return isDevelopmentEnvironment() && process.env.FLEET_DEV_GOOGLE_AUTH_ENABLED === "true";
}

function fleetDevGoogleConfig(): {
  publishableKey: string;
  allowedAuthId: string;
  allowedCanonicalId: string;
} | null {
  if (!isFleetDevGoogleMode()) return null;
  if (process.env.APP_BASE_URL?.replace(/\\/$/, "") !== FLEET_DEV_GOOGLE_ORIGIN) return null;
  const publishableKey = process.env.FLEET_DEV_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const allowedAuthId = process.env.FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID?.trim() ?? "";
  const allowedCanonicalId = process.env.FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID?.trim() ?? "";
  if (!publishableKey || !allowedAuthId || !allowedCanonicalId || !getSessionSecret()) return null;
  return { publishableKey, allowedAuthId, allowedCanonicalId };
}


export async function initializeProductionSessionSigning(): Promise<void> {
  if (isDevelopmentEnvironment()) return;
  if (getSessionSecret()) return;
  if (productionSessionInitialization) {
    await productionSessionInitialization;
    return;
  }

  productionSessionInitialization = (async () => {
    const explicitSecret = getExplicitSessionSecret();
    if (explicitSecret) {
      initializedProductionSessionSecret = explicitSecret;
      return;
    }

    // Password/OTP login has already proven that the canonical production
    // database path is available. Derive the signing key from that same
    // high-entropy runtime credential instead of making login depend on a
    // second external Secret Manager request. This keeps Hostinger login
    // available during GCP OAuth/Secret Manager latency or outages.
    const databaseCredential = await getRuntimeDatabaseUrl();
    initializedProductionSessionSecret =
      deriveProductionSessionSecret(databaseCredential);
  })();

  try {
    await productionSessionInitialization;
  } finally {
    productionSessionInitialization = null;
  }
}

function getDevIdentitySecret(): string | null {
  const secret = process.env.DEV_IDENTITY_SECRET ?? process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function getAllowedEmails(): string[] {
  const configuredEmails = (process.env.DEV_LOGIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return configuredEmails;
}

function getDevCompanyId(): number | null {
  const raw = String(process.env.DEV_COMPANY_ID ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("DEV_COMPANY_ID harus berupa integer positif.");
  }
  return value;
}

function getDevUsers(): DevAuthUser[] {
  const role = process.env.DEV_LOGIN_ROLE?.trim() || "admin";
  const companyId = getDevCompanyId();
  return getAllowedEmails().map((email) => {
    const name = email.split("@", 1)[0].replace(/[._-]+/g, " ").trim();
    const firstName = name ? name.replace(/\b\w/g, (letter) => letter.toUpperCase()) : null;
    return {
      id: `dev:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
      email,
      firstName,
      lastName: null,
      role,
      companyId,
    };
  });
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function getDevIdentitySignature(user: DevAuthUser): string | null {
  if (!isDevelopmentEnvironment()) return null;

  const secret = getDevIdentitySecret();
  if (!secret) return null;

  return sign(`${user.email}\n${user.role}`, secret);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function setSessionCookie(response: Response, session: DevSession): void {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET is unavailable");

  const payload = encode(JSON.stringify(session));
  const value = `${payload}.${sign(payload, secret)}`;
  response.append(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=${value}; Max-Age=${DEV_SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

export function setProductionSessionCookie(response: Response, session: ProductionSession): void {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET is unavailable");

  const payload = encode(JSON.stringify(session));
  const value = `${payload}.${sign(payload, secret)}`;
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  response.append(
    "Set-Cookie",
    `${PRODUCTION_SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function clearSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function clearProductionSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${PRODUCTION_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function decodeSignedCookie<T>(request: Request, cookieName: string): T | null {
  const secret = getSessionSecret();
  const raw = getCookie(request, cookieName);
  if (!secret || !raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(sign(payload, secret), signature)) return null;

  try {
    return JSON.parse(decode(payload)) as T;
  } catch {
    return null;
  }
}

export function getDevSession(request: Request): DevAuthUser | null {
  if (!isDevelopmentEnvironment()) return null;

  // When Google mode is ON, reject all legacy passwordless DEV sessions.
  if (isFleetDevGoogleMode()) {
    const config = fleetDevGoogleConfig();
    if (!config) return null;
    const session = decodeSignedCookie<DevSession & {
      authSupabaseId: string;
      canonicalUserId: string;
      authSource: string;
    }>(request, FLEET_DEV_GOOGLE_COOKIE);
    if (!session || session.authSource !== "verified_supabase_google" ||
        session.authSupabaseId !== config.allowedAuthId ||
        session.canonicalUserId !== config.allowedCanonicalId ||
        session.role !== "super_admin" || session.companyId !== 1 ||
        session.id !== session.authSupabaseId ||
        typeof session.email !== "string" || !session.email.includes("@") ||
        !Number.isFinite(session.issuedAt) || !Number.isFinite(session.expiresAt) ||
        session.issuedAt > Date.now() || session.expiresAt <= Date.now() ||
        session.expiresAt - session.issuedAt > FLEET_DEV_GOOGLE_SESSION_MS) return null;
    return {
      id: session.id, email: session.email,
      role: "super_admin", companyId: 1,
      firstName: session.firstName, lastName: session.lastName,
    };
  }

  const secret = getSessionSecret();
  const raw = getCookie(request, DEV_SESSION_COOKIE);
  if (!secret || !raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(sign(payload, secret), signature)) return null;

  try {
    const session = JSON.parse(decode(payload)) as DevSession;
    if (
      !session ||
      typeof session.email !== "string" ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Date.now()
    ) {
      return null;
    }

    const configuredUser = getDevUsers().find((user) => user.email === session.email);
    return configuredUser ?? null;
  } catch {
    return null;
  }
}

export function getProductionSession(request: Request): ProductionSession | null {
  if (isDevelopmentEnvironment()) return null;

  const session = decodeSignedCookie<ProductionSession>(request, PRODUCTION_SESSION_COOKIE);
  if (
    !session ||
    typeof session.id !== "string" ||
    typeof session.email !== "string" ||
    typeof session.expiresAt !== "number" ||
    session.expiresAt <= Date.now()
  ) {
    return null;
  }

  return {
    ...session,
    email: session.email.trim().toLowerCase(),
  };
}

function getSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
}

async function verifySupabaseAccessToken(accessToken: string): Promise<{
  id: string;
  email: string;
  expiresAt: number;
} | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Supabase Auth configuration is unavailable");

  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.anonKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return null;

  const user = await response.json() as {
    id?: unknown;
    email?: unknown;
  };
  if (typeof user.id !== "string" || typeof user.email !== "string") return null;

  const tokenParts = accessToken.split(".");
  let expiresAt = 0;
  let usedOtp = false;
  try {
    const claims = JSON.parse(decode(tokenParts[1] ?? "")) as {
      exp?: unknown;
      amr?: unknown;
    };
    if (typeof claims.exp === "number") expiresAt = claims.exp * 1000;
    usedOtp = Array.isArray(claims.amr) && claims.amr.some((entry) => (
      typeof entry === "object"
      && entry !== null
      && "method" in entry
      && (entry as { method?: unknown }).method === "otp"
    ));
  } catch {
    return null;
  }
  if (!usedOtp || expiresAt <= Date.now()) return null;

  return {
    id: user.id,
    email: user.email.trim().toLowerCase(),
    expiresAt,
  };
}

export async function getProductionUser(session: ProductionSession): Promise<DevAuthUser | null> {
  const result = await pool.query<{ user_data: Record<string, unknown> }>(
    `select to_jsonb(u) user_data
     from public.users u
     where lower(coalesce(to_jsonb(u)->>'email', '')) = $1
     limit 1`,
    [session.email],
  );
  const userData = result.rows[0]?.user_data;
  if (!userData) return null;

  const email = typeof userData.email === "string" ? userData.email.trim().toLowerCase() : "";
  const role = typeof userData.role === "string" ? userData.role.trim().toLowerCase() : "";
  if (email !== session.email || !role) return null;

  const rawCompanyId = userData.company_id ?? userData.companyId;
  const parsedCompanyId = rawCompanyId === null || rawCompanyId === undefined
    ? null
    : Number(rawCompanyId);
  return {
    id: session.id,
    email,
    firstName: typeof userData.first_name === "string" ? userData.first_name : null,
    lastName: typeof userData.last_name === "string" ? userData.last_name : null,
    role,
    companyId: parsedCompanyId !== null && Number.isInteger(parsedCompanyId) && parsedCompanyId > 0
      ? parsedCompanyId
      : null,
  };
}

function getSafeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

export function createDevAuthRouter(): Router {
  const router = Router();

  // Keep Fleet PROD's existing Google provider flow untouched.
  router.get("/auth/google/status", (_request, response, next) => {
    if (!isDevelopmentEnvironment()) return next();
    response.setHeader("Cache-Control", "no-store");
    response.json({ enabled: fleetDevGoogleConfig() !== null });
  });

  router.get("/auth/google/start", (request, response, next) => {
    if (!isDevelopmentEnvironment()) return next();
    const cfg = fleetDevGoogleConfig();
    if (!cfg || !request.secure || request.hostname !== "dev-fleet.cstlogistic.co.id") {
      response.status(404).json({ error: "Google DEV not configured" });
      return;
    }
    const authorize = new URL("/auth/v1/authorize", FLEET_DEV_GOOGLE_SUPABASE_URL);
    authorize.searchParams.set("provider", "google");
    authorize.searchParams.set("redirect_to", FLEET_DEV_GOOGLE_ORIGIN + "/logistics/fleet-intelligence/vehicles");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.redirect(302, authorize.toString());
  });

  router.post("/auth/google-dev-exchange", async (request, response): Promise<void> => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    const cfg = fleetDevGoogleConfig();
    if (!cfg || !request.secure || request.hostname !== "dev-fleet.cstlogistic.co.id" ||
        request.get("origin") !== FLEET_DEV_GOOGLE_ORIGIN ||
        !request.is("application/json")) {
      response.status(403).json({ error: "DEV Google exchange forbidden" });
      return;
    }
    const token = typeof request.body?.access_token === "string"
      ? request.body.access_token.trim() : "";
    if (token.length < 80 || token.length > 16000) {
      response.status(401).json({ error: "Invalid Google session" });
      return;
    }
    const expiry = verifiedGoogleOAuthExpiry(token);
    if (!expiry) {
      response.status(401).json({ error: "Verified Google OAuth session required" });
      return;
    }
    try {
      const verified = await fetch(FLEET_DEV_GOOGLE_SUPABASE_URL + "/auth/v1/user", {
        method: "GET",
        headers: {
          apikey: cfg.publishableKey,
          Authorization: "Bearer " + token,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!verified.ok) {
        response.status(401).json({ error: "Invalid Google session" });
        return;
      }
      const identity = trustedFleetDevGoogleIdentity(await verified.json(), {
        allowedAuthId: cfg.allowedAuthId,
        allowedCanonicalId: cfg.allowedCanonicalId,
      });
      if (!identity) {
        response.status(403).json({ error: "Super Admin Fleet DEV authorization denied" });
        return;
      }
      const now = Date.now();
      const session: DevSession & {
        authSupabaseId: string;
        canonicalUserId: string;
        authSource: string;
      } = {
        id: identity.id, email: identity.email,
        firstName: null, lastName: null, role: "super_admin", companyId: 1,
        authSupabaseId: identity.id,
        canonicalUserId: identity.canonicalUserId,
        authSource: "verified_supabase_google",
        issuedAt: now,
        expiresAt: Math.min(expiry, now + FLEET_DEV_GOOGLE_SESSION_MS),
      };
      const payload = encode(JSON.stringify(session));
      response.append("Set-Cookie",
        FLEET_DEV_GOOGLE_COOKIE + "=" + payload + "." + sign(payload, getSessionSecret()!) +
        "; Max-Age=1800; Path=/; HttpOnly; Secure; SameSite=Lax");
      response.json({ user: {
        id: session.id, email: session.email, role: session.role, companyId: 1,
      } });
    } catch {
      response.status(503).json({ error: "Google verification temporarily unavailable" });
    }
  });



  router.post("/auth/supabase-exchange", async (request, response): Promise<void> => {
    if (isDevelopmentEnvironment()) {
      response.status(404).json({ error: "Not found" });
      return;
    }

    const accessToken =
      typeof request.body?.access_token === "string"
        ? request.body.access_token.trim()
        : "";
    if (!accessToken) {
      response.status(401).json({ error: "Session Supabase tidak tersedia." });
      return;
    }
    if (!getSessionSecret()) {
      response.status(503).json({ error: "Konfigurasi session server belum tersedia." });
      return;
    }

    try {
      const verified = await verifySupabaseAccessToken(accessToken);
      if (!verified) {
        response.status(401).json({ error: "Session Supabase tidak valid atau sudah berakhir." });
        return;
      }

      const now = Date.now();
      const productionSession = {
        id: verified.id,
        email: verified.email,
        issuedAt: now,
        expiresAt: verified.expiresAt,
      };
      const user = await getProductionUser(productionSession);
      if (!user || user.role !== "admin") {
        response.status(403).json({
          error: "Email atau kode OTP tidak dapat digunakan untuk login admin.",
        });
        return;
      }

      setProductionSessionCookie(response, productionSession);
      response.json({ user });
    } catch (error) {
      request.log.error({ error }, "Supabase access token verification failed");
      response.status(503).json({ error: "Verifikasi session Supabase tidak tersedia." });
    }
  });

  router.get("/auth/dev-users", (_request, response) => {
    if (!isDevelopmentEnvironment() || isFleetDevGoogleMode())
      return response.status(404).json({ error: "Not found" });
    return response.json({ users: getDevUsers() });
  });

  router.post("/auth/dev-login", async (request, response) => {
    if (!isDevelopmentEnvironment() || isFleetDevGoogleMode())
      return response.status(404).json({ error: "Not found" });

    const email =
      typeof request.body?.email === "string"
        ? request.body.email.trim().toLowerCase()
        : "";
    const configuredUsers = getDevUsers();
    // An empty email is the intentional development auto-login path. Prefer
    // an explicitly configured admin, then fall back to the first dev user.
    const user = email
      ? configuredUsers.find((candidate) => candidate.email === email)
      : configuredUsers.find((candidate) => candidate.role === "admin") ?? configuredUsers[0];

    if (!getSessionSecret()) {
      return response.status(503).json({
        error: "Dev login belum aktif: SESSION_SECRET harus tersedia.",
      });
    }
    if (configuredUsers.length === 0) {
      return response.status(503).json({
        error: "Dev login belum dikonfigurasi: DEV_LOGIN_EMAILS masih kosong.",
      });
    }
    if (!user) {
      return response.status(403).json({
        error: "Email belum diizinkan untuk Dev Login.",
      });
    }
    if (!user.companyId) {
      return response.status(503).json({
        error: "Dev login belum aktif: DEV_COMPANY_ID wajib dikonfigurasi.",
      });
    }

    const now = Date.now();
    setSessionCookie(response, {
      ...user,
      issuedAt: now,
      expiresAt: now + DEV_SESSION_TTL_SECONDS * 1000,
    });
    return response.json({ user });
  });

  router.get("/auth/user", async (request, response, next): Promise<void> => {
    if (!isDevelopmentEnvironment()) {
      const session = getProductionSession(request);
      if (!session) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
      try {
        const user = await getProductionUser(session);
        if (!user) {
          response.status(403).json({ error: "Forbidden" });
          return;
        }
        response.json({ user });
      } catch (error) {
        request.log.error({ error }, "Failed to load production auth user");
        response.status(503).json({ error: "Authorization service unavailable" });
      }
      return;
    }

    const user = getDevSession(request);
    if (user) {
      response.json({ user });
      return;
    }
    next();
  });

  router.get("/users/me", (request, response, next) => {
    if (!isDevelopmentEnvironment()) return next();

    const user = getDevSession(request);
    if (!user) return next();

    return response.json({
      id: user.id,
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
      role: user.role,
    });
  });

  router.get("/logout", (request, response, next) => {
    if (!isDevelopmentEnvironment()) {
      clearProductionSessionCookie(response);
      response.redirect(getSafeRedirect(request.query.redirect));
      return;
    }
    if (isFleetDevGoogleMode()) {
      response.setHeader("Set-Cookie",
        FLEET_DEV_GOOGLE_COOKIE + "=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
      return response.redirect(getSafeRedirect(request.query.redirect));
    }
    if (!getDevSession(request)) return next();

    clearSessionCookie(response);
    return response.redirect(getSafeRedirect(request.query.redirect));
  });

  return router;
}