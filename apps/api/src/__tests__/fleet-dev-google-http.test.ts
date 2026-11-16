import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
// Import the Fleet router only after a synthetic CST-DEV DB env is set.

const ORIGIN = "https://dev-fleet.cstlogistic.co.id";
const AUTH_ID = "2d504b60-9172-4a2d-910b-2d80d9214156";
const CANON = "42";
const user = {
  id: AUTH_ID,
  email: "approved.dev@example.invalid",
  email_confirmed_at: "2026-11-16T01:00:00.000Z",
  app_metadata: {
    provider: "google", providers: ["google"],
    ai_task_user_id: CANON, ai_task_role: "super_admin", ai_task_company_id: "@NULL@",
  },
};
const originalFetch = globalThis.fetch;
const keys = [
  "APP_ENV", "NODE_ENV", "APP_BASE_URL", "SESSION_SECRET",
  "FLEET_DEV_GOOGLE_AUTH_ENABLED", "FLEET_DEV_SUPABASE_PUBLISHABLE_KEY",
  "FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID", "FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID",
  "SUPABASE_DATABASE_URL_DEV",
] as const;
const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

const jwt = (exp: number, method: string) => "eyJhbGciOiJIUzI1NiJ9." +
  Buffer.from(JSON.stringify({ aud: "authenticated", exp, amr: [{ method }] })).toString("base64url") +
  ".only_mocked_gotrue_verification";

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of keys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Fleet DEV Google SSO HTTP route E2E with MOCKED GoTrue only", () => {
  it("requires Google OAuth, exact pinned Super Admin, HTTPS origin, signed cookie and blocks passwordless DEV login", async () => {
    Object.assign(process.env, {
      APP_ENV: "development",
      NODE_ENV: "production",
      APP_BASE_URL: ORIGIN,
      SESSION_SECRET: "mocked_fleet_dev_session_signing_secret_for_automated_tests_only",
      FLEET_DEV_GOOGLE_AUTH_ENABLED: "true",
      FLEET_DEV_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_mock_never_real",
      FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID: AUTH_ID,
      FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID: CANON,
      SUPABASE_DATABASE_URL_DEV: "postgresql://postgres.xssrfshdrtdfupgqwfdw:fake@127.0.0.1:65432/fleet_dev_test",
    });
    let goTrueUser: object | null = user;
    let gotrueCalls = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://xssrfshdrtdfupgqwfdw.supabase.co/auth/v1/user")) {
        gotrueCalls++;
        if (!String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").startsWith("Bearer "))
          throw new Error("Missing mock test bearer");
        return new Response(JSON.stringify(goTrueUser), {
          status: goTrueUser ? 200 : 401, headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(url, init);
    });

    const { createDevAuthRouter } = await import("../routes/dev-auth");
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/api", createDevAuthRouter());
    app.use((_request, response) => { response.status(401).json({ error: "Not authorized" }); });
    const server: Server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Bad loopback listener");
      const base = "http://127.0.0.1:" + address.port;
      const headers = {
        "Host": "dev-fleet.cstlogistic.co.id",
        "X-Forwarded-Host": "dev-fleet.cstlogistic.co.id",
        "X-Forwarded-Proto": "https",
      };
      const get = (path: string, extraHeaders: Record<string, string> = {}) =>
        originalFetch(base + path, {
          headers: { ...headers, ...extraHeaders },
          redirect: "manual",
        });
      const post = (path: string, token: string, extraHeaders: Record<string, string> = {}) =>
        originalFetch(base + path, {
          method: "POST",
          headers: {
            ...headers, "content-type": "application/json",
            Origin: ORIGIN, ...extraHeaders,
          },
          body: JSON.stringify({ access_token: token }),
          redirect: "manual",
        });

      expect((await get("/api/auth/user")).status).toBe(401);
      expect((await get("/api/auth/dev-users")).status).toBe(404);
      expect((await originalFetch(base + "/api/auth/dev-login", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ email: "approved.dev@example.invalid" }),
      })).status).toBe(404);

      const status = await get("/api/auth/google/status");
      expect(status.status).toBe(200);
      expect(await status.json() as { enabled: boolean; devGoogleOnly: boolean }).toMatchObject({
        enabled: true, devGoogleOnly: true,
      });

      const start = await get("/api/auth/google/start");
      expect(start.status).toBe(302);
      const redirected = new URL(start.headers.get("location") ?? "");
      expect(redirected.origin).toBe("https://xssrfshdrtdfupgqwfdw.supabase.co");
      expect(redirected.pathname).toBe("/auth/v1/authorize");
      expect(redirected.searchParams.get("provider")).toBe("google");
      expect(redirected.searchParams.get("redirect_to")).toBe(
        ORIGIN + "/logistics/fleet-intelligence/vehicles");

      const token = jwt(Math.floor(Date.now() / 1000) + 900, "oauth");
      expect((await post("/api/auth/google-dev-exchange", token, { Origin: "https://attacker.invalid" })).status).toBe(403);
      expect((await post("/api/auth/google-dev-exchange", jwt(Math.floor(Date.now() / 1000) + 900, "otp"))).status).toBe(401);
      expect(gotrueCalls).toBe(0);
      goTrueUser = { ...user, app_metadata: { ...user.app_metadata, ai_task_role: "admin" } };
      expect((await post("/api/auth/google-dev-exchange", token)).status).toBe(403);
      goTrueUser = { ...user, app_metadata: { ...user.app_metadata, ai_task_company_id: "2" } };
      expect((await post("/api/auth/google-dev-exchange", token)).status).toBe(403);
      goTrueUser = user;

      const login = await post("/api/auth/google-dev-exchange", token);
      expect(login.status).toBe(200);
      expect(login.headers.get("cache-control")).toContain("no-store");
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie.startsWith("fleet_dev_google_session=")).toBe(true);
      const directives = login.headers.get("set-cookie") ?? "";
      expect(directives).toContain("Secure");
      expect(directives).toContain("HttpOnly");
      expect(directives).toContain("SameSite=Lax");
      const accepted = await get("/api/auth/user", { Cookie: cookie });
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as { user: { role: string; companyId: number } }).user).toMatchObject({
        role: "super_admin", companyId: 1,
      });
      const changedCookie = cookie.replace(/.$/, "X");
      expect((await get("/api/auth/user", { Cookie: changedCookie })).status).toBe(401);
      expect((await get("/api/auth/user", { Cookie: "fleet_dev_session=legacy_insecure" })).status).toBe(401);
      expect(gotrueCalls).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
