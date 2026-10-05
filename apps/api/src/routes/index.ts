import { Router, type IRouter } from "express";
import fleetIntelligenceRouter from "./fleet-intelligence";
import localProductionAuthRouter from "./local-production-auth";
import { createDevAuthRouter } from "./dev-auth";
import { pool } from "../lib/db";

const router: IRouter = Router();

router.get("/", (_req, res) => {
  res.json({ status: "ok", service: "fleet-intelligence-api" });
});

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "fleet-intelligence-api" });
});

router.get("/readyz", async (req, res) => {
  try {
    const result = await pool.query<{
      fleet_drivers: string | null;
      fleet_outstanding: string | null;
      gojek_raw_transactions: string | null;
      fleet_settings: string | null;
      fleet_wa_worker_state: string | null;
      companies: string | null;
    }>(`
      select
        to_regclass('public.fleet_drivers')::text as fleet_drivers,
        to_regclass('public.fleet_outstanding')::text as fleet_outstanding,
        to_regclass('public.gojek_raw_transactions')::text as gojek_raw_transactions,
        to_regclass('public.fleet_settings')::text as fleet_settings,
        to_regclass('public.fleet_wa_worker_state')::text as fleet_wa_worker_state,
        to_regclass('public.companies')::text as companies
    `);

    const tables = result.rows[0];
    const missing = Object.entries(tables ?? {})
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length) {
      res.status(503).json({
        status: "not_ready",
        service: "fleet-intelligence-api",
        reason: "required_tables_missing",
        missing,
      });
      return;
    }

    res.json({
      status: "ready",
      service: "fleet-intelligence-api",
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

router.use(createDevAuthRouter());
router.use(localProductionAuthRouter);
router.use("/logistics/fleet", fleetIntelligenceRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "Fleet endpoint not found", code: "FLEET_ENDPOINT_NOT_FOUND" });
});

export default router;
