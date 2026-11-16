import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { trustedFleetDevGoogleIdentity, verifiedGoogleOAuthExpiry } from "../lib/fleet-dev-google-identity";

const AUTH_ID = "2d504b60-9172-4a2d-910b-2d80d9214156";
const CANON = "42";
const verified = {
  id: AUTH_ID, email: "Approved.Dev@Example.Invalid",
  email_confirmed_at: "2026-11-16T01:00:00Z",
  app_metadata: { provider: "google", providers: ["google"],
    ai_task_user_id: CANON, ai_task_role: "super_admin", ai_task_company_id: "@NULL@" },
};
const options = { allowedAuthId: AUTH_ID, allowedCanonicalId: CANON };
const jwt = (body: object) => "eyJhbGciOiJIUzI1NiJ9." +
  Buffer.from(JSON.stringify(body)).toString("base64url") + ".dummy_signature";

describe("Fleet DEV Supabase Google Super Admin pin", () => {
  it("requires one exact immutable authorized Supabase subject and canonical Super Admin pin", () => {
    expect(trustedFleetDevGoogleIdentity(verified, options)).toMatchObject({
      id: AUTH_ID, email: "approved.dev@example.invalid",
      role: "super_admin", companyId: 1, canonicalUserId: CANON,
    });
  });
  it("rejects spoofed IDs, role, company, provider and unverified email", () => {
    const cases = [
      { ...verified, id: "792e98b3-8a62-4744-acb7-aae16ecb26ac" },
      { ...verified, email_confirmed_at: null },
      { ...verified, app_metadata: { ...verified.app_metadata, ai_task_user_id: "43" } },
      { ...verified, app_metadata: { ...verified.app_metadata, ai_task_role: "admin" } },
      { ...verified, app_metadata: { ...verified.app_metadata, ai_task_company_id: "1" } },
      { ...verified, app_metadata: { ...verified.app_metadata, ai_task_company_id: "2" } },
      { ...verified, app_metadata: { ...verified.app_metadata, provider: "email", providers: ["email"] } },
      { ...verified, app_metadata: { provider: "google" } },
    ];
    cases.forEach((value) => expect(trustedFleetDevGoogleIdentity(value, options)).toBeNull());
    expect(trustedFleetDevGoogleIdentity(verified, { ...options, allowedAuthId: "other" })).toBeNull();
  });
  it("requires verified token claim shape with OAuth and bounded future expiry", () => {
    const now=Date.UTC(2026,10,16,10);
    const good=jwt({aud:"authenticated",exp:Math.floor(now/1000)+3600,amr:[{method:"oauth"}]});
    expect(verifiedGoogleOAuthExpiry(good,now)).toBe(now+3600000);
    for (const claims of [
      {aud:"authenticated",exp:Math.floor(now/1000)-1,amr:[{method:"oauth"}]},
      {aud:"anon",exp:Math.floor(now/1000)+3600,amr:[{method:"oauth"}]},
      {aud:"authenticated",exp:Math.floor(now/1000)+3600,amr:[{method:"otp"}]},
      {aud:"authenticated",exp:Math.floor(now/1000)+9*86400,amr:[{method:"oauth"}]},
    ]) expect(verifiedGoogleOAuthExpiry(jwt(claims),now)).toBeNull();
    expect(verifiedGoogleOAuthExpiry("garbage",now)).toBeNull();
  });
  it("keeps Google DEV mode fail-closed and disables legacy passwordless login", () => {
    const router=readFileSync(resolve(process.cwd(),"src/routes/dev-auth.ts"),"utf8");
    const client=readFileSync(resolve(process.cwd(),"../web/src/App.tsx"),"utf8");
    expect(router).toContain('process.env.FLEET_DEV_GOOGLE_AUTH_ENABLED === "true"');
    expect(router).toContain("if (!isDevelopmentEnvironment() || isFleetDevGoogleMode())");
    expect(router).toContain('"/auth/google-dev-exchange"');
    expect(router).toContain('"/auth/v1/user"');
    expect(router).toContain("trustedFleetDevGoogleIdentity");
    expect(router).toContain("response.status(403)");
    expect(router).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(router).toContain("request.get(\"origin\") !== FLEET_DEV_GOOGLE_ORIGIN");
    expect(router).toContain("request.hostname !== \"dev-fleet.cstlogistic.co.id\"");
    expect(client).toContain("window.history.replaceState");
    expect(client).toContain("window.location.origin");
    expect(client).toContain('"/api/auth/google-dev-exchange"');
    expect(client).not.toContain("localStorage.setItem");
  });
});
