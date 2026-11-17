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

describe("Fleet DEV staging Compose isolation", () => {
  it("uses project-scoped container and network names instead of global names", () => {
    expect(compose).not.toMatch(/^\s*container_name\s*:/m);
    expect(compose).not.toMatch(/^\s*name\s*:\s*cst-fleet-dev\b/m);
    expect(compose).toMatch(/networks:\s*\n\s+fleet-dev:\s*\{\}/);
    expect(workflow).toContain("--project-name fleet-integration-stage");
  });

  it("keeps the second deployment loopback only and disables writes/schedulers", () => {
    expect(compose).toContain('"127.0.0.1:18460:80"');
    expect(compose).toContain('CENTRAL_FINANCE_WRITE_ENABLED: "false"');
    expect(compose).toContain('GOJEK_CONNECTOR_ENABLED: "false"');
    expect(compose).toContain('DISABLE_BACKGROUND_SCHEDULERS: "true"');
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
    expect(workflow).toContain('test "$gojek_code" = 409');
    expect(workflow).toContain('test "$vehicles_page" = 200');
    expect(workflow).toContain('test "$tx_page" = 200');
    expect(workflow).toContain('test ! -e deploy/.env.dev');
  });

  it("keeps public Nginx and Fleet PROD outside the staging workflow", () => {
    expect(workflow).toContain('refs/heads/dev/fleet-pr103-pr110-stabilization-20261117');
    expect(workflow).toContain("github.event.inputs.mode == 'stage-dev'");
    expect(workflow).toContain("environment: fleet-dev");
    expect(workflow).not.toMatch(/^\s*nginx\s+(?:-s|reload)\b/m);
  });
});
