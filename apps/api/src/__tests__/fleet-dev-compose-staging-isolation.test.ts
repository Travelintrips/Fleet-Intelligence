import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(
  resolve(process.cwd(), "../../deploy/docker-compose.dev.yml"),
  "utf8",
);
const workflow = readFileSync(
  resolve(process.cwd(), "../../.github/workflows/deploy-dev.yml"),
  "utf8",
);
const stagingNginx = readFileSync(
  resolve(process.cwd(), "../../deploy/dev-only/nginx-staging-readonly.conf"),
  "utf8",
);

describe("Fleet DEV staging Compose isolation", () => {
  it("uses project-scoped container and network names instead of global names", () => {
    expect(compose).not.toMatch(/^\s*container_name\s*:/m);
    expect(compose).not.toMatch(/^\s*name\s*:\s*cst-fleet-dev\b/m);
    expect(compose).toMatch(/networks:\s*\n\s+fleet-dev:\s*\{\}/);
    expect(workflow).toContain("--project-name fleet-integration-stage");
  });

  it("keeps the second deployment loopback only and disables writes/schedulers", () => {
    expect(compose).toContain('"127.0.0.1:18460:80"');
    expect(compose).toContain("./dev-only/nginx-staging-readonly.conf:/etc/nginx/conf.d/default.conf:ro");
    expect(compose).toContain('CENTRAL_FINANCE_WRITE_ENABLED: "false"');
    expect(compose).toContain('GOJEK_CONNECTOR_ENABLED: "false"');
    expect(compose).toContain('DISABLE_BACKGROUND_SCHEDULERS: "true"');
    // Dedicated stage role is limited to 3 connections; never default to a 10-slot pool.
    expect(compose).toContain('DB_POOL_MAX: "2"');
    expect(compose).not.toContain("--remove-orphans");
    expect(workflow).not.toContain("--remove-orphans");
    expect(workflow).toContain('test "$DEPLOY_PATH" = "/opt/fleet-intelligence-dev"');
  });

  it("requires a real HTTP 200 for staged web and API readiness, never a 308 redirect", () => {
    expect(workflow).toContain("web_code=$(curl");
    expect(workflow).toContain("api_code=$(curl");
    expect(workflow).toContain("--header 'X-Forwarded-Proto: https'");
    expect(workflow).toContain('if [ "$web_code" = "200" ] && [ "$api_code" = "200" ]; then');
    expect(workflow).not.toContain("if curl --fail --silent http://127.0.0.1:18460/healthz");
    expect(workflow).toContain("Staging readiness pending: web=$web_code api=$api_code");
  });

  it("requires a real CST-only read-only DB check after stage HTTP readiness", () => {
    const dbSmoke = readFileSync(
      resolve(process.cwd(), "../../deploy/dev-only/check-fleet-dev-stage-db.cjs"),
      "utf8",
    );
    expect(workflow).toContain("node --check deploy/dev-only/check-fleet-dev-stage-db.cjs");
    expect(workflow).toContain("node -e \"$(cat deploy/dev-only/check-fleet-dev-stage-db.cjs)\"");
    expect(dbSmoke).toContain('row.login_role === "fleet_dev_stage_reader"');
    expect(dbSmoke).toContain('row.readonly === "on"');
    expect(dbSmoke).toContain("other_company_transactions");
    expect(dbSmoke).toContain("row.may_insert === false");
    expect(dbSmoke).toContain("row.may_update === false");
    expect(dbSmoke).toContain("Number(row.transactions) >= 425");
  });

  it("runs a disposable synthetic web/API Compose E2E in validate without stage-dev", () => {
    expect(workflow).toContain("Synthetic staged Compose HTTP E2E (no real credentials)");
    expect(workflow).toContain("synthetic_no_db");
    expect(workflow).toContain("--project-name fleet-integration-stage");
    expect(workflow).toContain("up -d --build");
    expect(workflow).toContain("down --volumes");
    expect(workflow).toContain("rm -f deploy/.env.dev");
    expect(workflow).toContain('test "$plain_code" = 308');
    expect(workflow).toContain('test "$auth_code" = 401');
    expect(workflow).toContain('test "$tx_code" = 401');
    expect(workflow).toContain('test "$gojek_code" = 404');
    expect(workflow).toContain('test "$direct_gojek_code" = 409');
    expect(workflow).toContain('test "$upload_code" = 404');
    expect(workflow).toContain('test "$wa_code" = 404');
    expect(workflow).toContain('test "$transaction_post_code" = 403');
    expect(workflow).toContain('test "$vehicles_page" = 200');
    expect(workflow).toContain('test "$tx_page" = 200');
    expect(workflow).toContain('test ! -e deploy/.env.dev');
  });

  it("uses a staged read-only HTTP allowlist, not the shared production Nginx config", () => {
    for (const path of [
      "/api/healthz",
      "/api/auth/google/status",
      "/api/auth/google/start",
      "/api/auth/user",
      "/api/logout",
      "/api/logistics/fleet/vehicles",
      "/api/logistics/fleet/transactions",
      "/api/auth/google-dev-exchange",
      "/logistics/fleet-intelligence/vehicles",
      "/logistics/fleet-intelligence/transactions",
    ]) {
      expect(stagingNginx).toContain(`location = ${path} {`);
    }
    expect(stagingNginx).toContain("location / { return 404; }");
    expect(stagingNginx).toContain("location ^~ /assets/ {");
    expect(stagingNginx).not.toMatch(/location\s+\/api\/\s*\{/);
    for (const blocked of [
      "/api/logistics/fleet/gojek-connector/handoff",
      "/api/logistics/fleet/reports/upload",
      "/api/logistics/fleet/outstanding/wa-blast",
    ]) {
      expect(stagingNginx).not.toContain(`location = ${blocked} {`);
    }
    expect(stagingNginx).toContain("limit_except POST { deny all; }");
    expect(stagingNginx).toContain("limit_except GET { deny all; }");
    expect(stagingNginx).toContain("proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;");
  });

  it("runs credential-free public DEV OAuth/read-only gates without claiming login PASS", () => {
    const checkScript = readFileSync(
      resolve(process.cwd(), "../../deploy/dev-only/check-fleet-dev-public-readonly.py"),
      "utf8",
    );
    expect(workflow).toContain("Public Fleet DEV read-only OAuth and API smoke (no credentials)");
    expect(workflow).toContain("python3 deploy/dev-only/check-fleet-dev-public-readonly.py");
    expect(checkScript).toContain("https://dev-fleet.cstlogistic.co.id");
    expect(checkScript).toContain("xssrfshdrtdfupgqwfdw.supabase.co");
    expect(checkScript).toContain("NoRedirect(HTTPRedirectHandler)");
    expect(checkScript).toContain('check_get("/api/auth/user", 401)');
    expect(checkScript).toContain('check_get("/api/logistics/fleet/vehicles", 401)');
    expect(checkScript).toContain("Fleet DEV read-only smoke 7 HTTP gates");
    expect(checkScript).not.toContain('method="POST"');
    expect(checkScript).not.toContain('"Cookie":');
  });

  it("keeps public Nginx and Fleet PROD outside the staging workflow", () => {
    expect(workflow).toContain('refs/heads/dev/fleet-pr103-pr110-stabilization-20261117');
    expect(workflow).toContain("github.event.inputs.mode == 'stage-dev'");
    expect(workflow).toContain("environment: fleet-dev");
    expect(workflow).not.toMatch(/^\s*nginx\s+(?:-s|reload)\b/m);
  });
});
