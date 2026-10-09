import app from "./app";
import { logger } from "./lib/logger";
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
    const scheduledSync = await runFleetGojekScheduledSyncSweep();
    if (scheduledSync.length) logger.info({ scheduledSync }, "Gojek daily sync jobs queued");
    const [reminders, alerts] = await Promise.all([
      runFleetAutoReminderSweep(),
      runFleetAlertSweep(),
    ]);
    if (reminders.length) logger.info({ result: reminders }, "Fleet WA reminder sweep completed");
    if (alerts.length) logger.info({ result: alerts }, "Fleet alert sweep completed");
  } catch (error) {
    logger.error({ error }, "Fleet background sweep failed");
  } finally {
    running = false;
  }
};

const timer = setInterval(() => void tick(), 5 * 60 * 1000);
timer.unref();
setTimeout(() => void tick(), 20_000).unref();

const runResend = () => void runFleetOneTimeResend().catch(error => logger.error({error}, "Fleet one-time resend failed"));
const resendTimer = setInterval(runResend, 60 * 1000);
resendTimer.unref();
setTimeout(runResend, 25_000).unref();

const runGroupReport = () => void runFleetGroupReportSweep().catch(error => logger.error({error}, "Fleet group report failed"));
const reportTimer = setInterval(runGroupReport, 5 * 60 * 1000);
reportTimer.unref();
setTimeout(runGroupReport, 35_000).unref();

const stop = () => { clearInterval(timer); clearInterval(reportTimer); clearInterval(resendTimer); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
server.on("error", (error) => {
  logger.error({ error }, "Fleet API server error");
  process.exit(1);
});
