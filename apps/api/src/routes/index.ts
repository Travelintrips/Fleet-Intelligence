import { Router, type IRouter } from "express";
import fleetIntelligenceRouter from "./fleet-intelligence";
import localProductionAuthRouter from "./local-production-auth";
import googleAuthRouter from "./google-auth";
import { createDevAuthRouter } from "./dev-auth";
import { pool } from "../lib/db";
import { getFleetWaGatewayStatus } from "../lib/wa-gateway-client";
import { getFleetFinanceReadiness } from "../lib/central-finance-client";
import { getFleetCashDatabaseStatus } from "../lib/fleet-cash-db";

const router: IRouter = Router();

router.get("/", (_req, res) => {
  res.json({ status: "ok", service: "fleet-intelligence-api" });
});

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "fleet-intelligence-api" });
});

router.get("/readyz", async (req, res) => {
  try {
    const result = await pool.query<Record<string, string | null>>(`
      select
        to_regclass('public.fleet_partners')::text as fleet_partners,
        to_regclass('public.fleet_drivers')::text as fleet_drivers,
        to_regclass('public.fleet_vehicles')::text as fleet_vehicles,
        to_regclass('public.fleet_reports')::text as fleet_reports,
        to_regclass('public.fleet_transactions')::text as fleet_transactions,
        to_regclass('public.fleet_outstanding')::text as fleet_outstanding,
        to_regclass('public.fleet_outstanding_import_log')::text as fleet_outstanding_import_log,
        to_regclass('public.fleet_alerts')::text as fleet_alerts,
        to_regclass('public.fleet_accounting_journals')::text as fleet_accounting_journals,
        to_regclass('public.fleet_cash_payments')::text as fleet_cash_payments,
        to_regclass('public.fleet_expenses')::text as fleet_expenses,
        to_regclass('public.fleet_expense_budgets')::text as fleet_expense_budgets,
        to_regclass('public.fleet_reconciliation_reports')::text as fleet_reconciliation_reports,
        to_regclass('public.fleet_settings')::text as fleet_settings,
        to_regclass('public.fleet_wa_logs')::text as fleet_wa_logs,
        to_regclass('public.fleet_wa_worker_state')::text as fleet_wa_worker_state,
        to_regclass('public.gojek_raw_transactions')::text as gojek_raw_transactions,
        to_regclass('public.gojek_failed_rows')::text as gojek_failed_rows,
        to_regclass('public.companies')::text as companies,
        to_regclass('public.users')::text as users,
        to_regclass('public.wa_otp_codes')::text as wa_otp_codes,
        to_regclass('public.bizportal_email_otp_codes')::text as bizportal_email_otp_codes,
        to_regclass('public.audit_logs')::text as audit_logs,
        to_regprocedure('public.fleet_import_driver_snapshot(integer,text,text,jsonb)')::text
          as fleet_import_driver_snapshot
    `);

    const dependencies = result.rows[0] ?? {};
    const missing = Object.entries(dependencies)
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length) {
      res.status(503).json({
        status: "not_ready",
        service: "fleet-intelligence-api",
        reason: "required_dependencies_missing",
        missing,
      });
      return;
    }

    res.json({
      status: "ready",
      service: "fleet-intelligence-api",
      dependencies: Object.keys(dependencies).length,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet readiness check failed");
    res.status(503).json({
      status: "not_ready",
      service: "fleet-intelligence-api",
      reason: "database_unavailable",
    });
  }
});

router.get("/integrationz", async (req, res) => {
  try {
    const [wa, finance, cashSource] = await Promise.all([
      getFleetWaGatewayStatus(), getFleetFinanceReadiness(1), getFleetCashDatabaseStatus(),
    ]);
    res.json({
      status: "ok",
      service: "fleet-intelligence-api",
      integrations: {
        wa: {
          configured: wa.configured,
          gatewayHealthy: wa.gatewayHealthy,
          gatewayStatus: wa.gatewayStatus,
          deviceConfigured: Boolean(wa.deviceId),
          deviceStatus: wa.deviceStatus,
          deviceOnline: wa.deviceStatus === "ONLINE",
          deviceSelection: wa.deviceSelection,
          assignedDeviceCount: wa.visibleDevices.length,
        },
        centralFinance: {
          ...finance,
          sourceDatabaseReady: cashSource.readReady,
          sourceWriteReady: cashSource.writeReady,
          writeReady: finance.writeReady && cashSource.writeReady,
        },
      },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet integration status failed");
    res.status(503).json({
      status: "degraded",
      service: "fleet-intelligence-api",
      reason: "integration_status_unavailable",
    });
  }
});

router.use(createDevAuthRouter());
router.use(localProductionAuthRouter);
router.use(googleAuthRouter);
router.use("/logistics/fleet", fleetIntelligenceRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "Fleet endpoint not found", code: "FLEET_ENDPOINT_NOT_FOUND" });
});

export default router;
