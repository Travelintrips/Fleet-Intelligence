import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const entry = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const devCompose = readFileSync(resolve(process.cwd(), "../../deploy/docker-compose.dev.yml"), "utf8");
const prodCompose = readFileSync(resolve(process.cwd(), "../../deploy/docker-compose.prod.yml"), "utf8");

describe("Fleet API DEV-only scheduler fence", () => {
  it("rejects scheduler startup in DEV when DISABLE_BACKGROUND_SCHEDULERS=true", () => {
    expect(entry).toContain("isDevelopmentEnvironment() && process.env.DISABLE_BACKGROUND_SCHEDULERS === \"true\"");
    expect(entry).toContain("const leaderRetryTimer = backgroundSchedulerDisabled");
    expect(entry).toContain("if (leaderRetryTimer) {");
    expect(entry).toContain("setTimeout(() => void tryBecomeBackgroundLeader(), 10_000).unref()");
    expect(entry).toContain("if (leaderRetryTimer) clearInterval(leaderRetryTimer)");
  });

  it("sets the stop flag in the official DEV compose, not PROD", () => {
    expect(devCompose).toContain('DISABLE_BACKGROUND_SCHEDULERS: "true"');
    expect(prodCompose).not.toContain("DISABLE_BACKGROUND_SCHEDULERS");
    expect(entry).toContain("isDevelopmentEnvironment()");
  });

  it("preserves existing production scheduling code and explicit background leader lock", () => {
    expect(entry).toContain("pg_try_advisory_lock(hashtext('fleet_background_leader'))");
    expect(entry).toContain("startBackgroundJobs();");
    expect(entry).toContain("const runGroupReport =");
    expect(entry).toContain("const runResend =");
    expect(entry).toContain("runFleetAutoReminderSweep()");
    expect(entry).toContain("runFleetGojekScheduledSyncSweep()");
  });
});
