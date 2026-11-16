import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "./lib/db";
import type { PoolClient } from "pg";
import { runFleetAutoReminderSweep, runFleetOneTimeResend } from "./lib/fleet-wa-reminder";
import { runFleetAlertSweep } from "./lib/fleet-alerts";
import { runFleetGojekScheduledSyncSweep } from "./lib/fleet-gojek-scheduler";
import { runFleetGroupReportSweep } from "./lib/fleet-group-report";
import { initializeProductionSessionSigning, isDevelopmentEnvironment } from "./routes/dev-auth";

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer.");
const host = process.env.HOST?.trim() || "0.0.0.0";

if (!isDevelopmentEnvironment()) {
  await initializeProductionSessionSigning();
}

const server = app.listen(port, host, () => {
  logger.info({ port, host }, "Fleet API listening");
});

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    // Isolate each maintenance task: a transient failure in one subsystem must
    // not prevent reminders or alerts from running on their established schedule.
    const jobs = [
      { name: "gojek-schedule", run: async () => {
        const scheduledSync = await runFleetGojekScheduledSyncSweep();
        if (scheduledSync.length) logger.info({ scheduledSync }, "Gojek daily sync jobs queued");
      } },
      { name: "wa-reminders", run: async () => {
        const reminders = await runFleetAutoReminderSweep();
        if (reminders.length) logger.info({ result: reminders }, "Fleet WA reminder sweep completed");
      } },
      { name: "alerts", run: async () => {
        const alerts = await runFleetAlertSweep();
        if (alerts.length) logger.info({ result: alerts }, "Fleet alert sweep completed");
      } },
    ];
    for (const job of jobs) {
      try {
        await job.run();
      } catch (error) {
        logger.error({ error, job: job.name }, "Fleet background task failed");
      }
    }
  } catch (error) {
    logger.error({ error }, "Fleet background sweep failed");
  } finally {
    running = false;
  }
};

let maintenanceTimer: NodeJS.Timeout | null = null;
let resendTimer: NodeJS.Timeout | null = null;
let reportTimer: NodeJS.Timeout | null = null;
let backgroundLeaderClient: PoolClient | null = null;
let acquiringBackgroundLeadership = false;

const stopBackgroundJobs = () => {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (resendTimer) clearInterval(resendTimer);
  if (reportTimer) clearInterval(reportTimer);
  maintenanceTimer = null;
  resendTimer = null;
  reportTimer = null;
};

const startBackgroundJobs = () => {
  if (maintenanceTimer || resendTimer || reportTimer) return;

  maintenanceTimer = setInterval(() => void tick(), 5 * 60 * 1000);
  maintenanceTimer.unref();
  setTimeout(() => void tick(), 20_000).unref();

  const runResend = () => void runFleetOneTimeResend().catch(error => logger.error({ error }, "Fleet one-time resend failed"));
  resendTimer = setInterval(runResend, 60 * 1000);
  resendTimer.unref();
  setTimeout(runResend, 25_000).unref();

  const runGroupReport = () => void runFleetGroupReportSweep().catch(error => logger.error({ error }, "Fleet group report failed"));
  reportTimer = setInterval(runGroupReport, 5 * 60 * 1000);
  reportTimer.unref();
  setTimeout(runGroupReport, 35_000).unref();
};

const tryBecomeBackgroundLeader = async () => {
  if (backgroundLeaderClient || acquiringBackgroundLeadership) return;
  acquiringBackgroundLeadership = true;
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('fleet_background_leader')) AS acquired",
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      return;
    }

    backgroundLeaderClient = client;
    client.on("error", (error) => {
      logger.error({ error }, "Fleet background leader DB connection lost");
      if (backgroundLeaderClient === client) backgroundLeaderClient = null;
      stopBackgroundJobs();
    });
    logger.info("Fleet background leadership acquired");
    startBackgroundJobs();
  } catch (error) {
    client.release();
    logger.error({ error }, "Fleet background leadership check failed");
  } finally {
    acquiringBackgroundLeadership = false;
  }
};

// DEV-only kill switch: keep Fleet API read routes available without ever
// acquiring advisory leader locks or launching WA/Gojek/Finance background jobs.
// PROD retains its existing scheduling behavior regardless of this flag.
const backgroundSchedulerDisabled =
  isDevelopmentEnvironment() && process.env.DISABLE_BACKGROUND_SCHEDULERS === "true";

const leaderRetryTimer = backgroundSchedulerDisabled
  ? null
  : setInterval(() => void tryBecomeBackgroundLeader(), 60 * 1000);
if (leaderRetryTimer) {
  leaderRetryTimer.unref();
  setTimeout(() => void tryBecomeBackgroundLeader(), 10_000).unref();
}

const stop = () => {
  if (leaderRetryTimer) clearInterval(leaderRetryTimer);
  stopBackgroundJobs();
  const client = backgroundLeaderClient;
  backgroundLeaderClient = null;
  if (client) {
    void client
      .query("SELECT pg_advisory_unlock(hashtext('fleet_background_leader'))")
      .catch(error => logger.warn({ error }, "Fleet background leadership unlock failed"))
      .finally(() => client.release());
  }
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
server.on("error", (error) => {
  logger.error({ error }, "Fleet API server error");
  process.exit(1);
});
