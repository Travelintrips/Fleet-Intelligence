import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const waClient = readFileSync(resolve(process.cwd(), "src/lib/wa-gateway-client.ts"), "utf8");
const alertEngine = readFileSync(resolve(process.cwd(), "src/lib/fleet-alerts.ts"), "utf8");
const serverEntry = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");

describe("Fleet production hardening contract", () => {
  it("does not count raw Gojek rows as trips", () => {
    expect(route).toContain("0::int AS total_trips");
    expect(route).toContain("COUNT(*)::int AS raw_transaction_rows");
    expect(route).toContain("COALESCE(SUM(trip_count),0)::int AS total_trips");
  });

  it("uses driver trip totals for top driver cards", () => {
    expect(route).toContain("COALESCE(d.total_trips,0)::int AS trips");
  });

  it("owns reminder scheduling in fleet_settings", () => {
    expect(route).toContain('router.get("/reminder-settings"');
    expect(route).toContain('router.put("/reminder-settings"');
    expect(route).toContain("auto_blast_enabled");
    expect(route).toContain("auto_blast_hour");
  });

  it("fails before recording a cash payment when Central Finance write is unavailable", () => {
    expect(route).toContain("assertCentralFinanceWriteEnabled();");
    expect(route).toContain("const canonicalSettings = await getFleetAccountingSettings(cid);");
    const guardIndex = route.indexOf("assertCentralFinanceWriteEnabled();");
    const insertIndex = route.indexOf("INSERT INTO public.fleet_cash_payments");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(guardIndex);
  });

  it("keeps Central Finance journal id when COA-only settings are updated", () => {
    expect(route).toContain("req.body?.journalId ?? current.journalId");
  });

  it("requires explicit confirmation before deleting an outstanding row", () => {
    expect(route).toContain("DELETE OUTSTANDING");
    expect(route).toContain("requireDestructiveConfirmation");
  });

  it("parses quoted multiline CSV fields instead of splitting by physical line", () => {
    expect(route).toContain("function csvRows(content: string)");
    expect(route).toContain('if ((ch === "\\n" || ch === "\\r") && !quoted)');
    expect(route).toContain('CSV memiliki kutip yang tidak tertutup.');
  });

  it("includes drivers with outstanding at least Rp50k for WA reminders", () => {
    const reminder = readFileSync(resolve(process.cwd(), "src/lib/fleet-wa-reminder.ts"), "utf8");
    expect(reminder).toContain("const minOutstanding = Math.max(50_000, Number(args.minOutstanding) || 0)");
    expect(reminder).toContain("o.outstanding_amount >= $2");
  });

  it("provides a guarded WhatsApp integration test endpoint", () => {
    expect(route).toContain('router.post("/wa/test"');
    expect(route).toContain("WA Gateway Fleet belum siap atau device belum ONLINE");
    expect(route).toContain("sendFleetWa({");
    expect(route).toContain("Pesan test maksimal 2000 karakter");
  });

  it("retries stale or disconnected WA device sends once", () => {
    expect(waClient).toContain("for (let attempt = 0; attempt < 2; attempt += 1)");
    expect(waClient).toContain("disconnected device");
    expect(waClient).toContain("deviceSelectionCache = null");
  });

  it("keeps failed auto reminders eligible for safe retry", () => {
    const reminder = readFileSync(resolve(process.cwd(), "src/lib/fleet-wa-reminder.ts"), "utf8");
    expect(reminder).toContain("5 * 60 * 1000 : 30 * 60 * 1000");
    expect(reminder).toContain("getFleetWaGatewayStatus()");
    expect(reminder).toContain("SET auto_blast_last_run=NULL");
  });

  it("exposes non-secret WA gateway and device health", () => {
    expect(route).toContain('router.get("/wa/status"');
    expect(waClient).toContain("getFleetWaGatewayStatus");
    expect(waClient).toContain("/health");
    expect(waClient).toContain("/v1/devices");
    expect(waClient).toContain("TOKEN_FORBIDDEN");
    expect(waClient).toContain("NOT_ASSIGNED");
    expect(waClient).toContain("single_online");
    expect(waClient).toContain("AMBIGUOUS_ONLINE_DEVICES");
    expect(waClient).toContain("DEVICE_CACHE_MS");
    expect(waClient).toContain("Promise.all([healthPromise, registryPromise])");
  });

  it("generates and refreshes automatic Fleet alerts", () => {
    expect(alertEngine).toContain("outstanding_high");
    expect(alertEngine).toContain("driver_inactive");
    expect(alertEngine).toContain("revenue_drop");
    expect(alertEngine).toContain("outstanding_amount >= 50000");
    expect(alertEngine).toContain("outstanding_amount >= 1000000");
    expect(alertEngine).toContain("last_active_date <= CURRENT_DATE - 7");
    expect(alertEngine).toContain("dropPct > 15");
    expect(alertEngine).toContain("auto_resolved_at=now()");
    expect(route).toContain("syncFleetAlertsForCompany(cid)");
    expect(serverEntry).toContain("runFleetAlertSweep()");
  });

  it("exposes heartbeat-backed Gojek connector status and queues driver sync", () => {
    expect(route).toContain('router.get("/gojek-connector/server-status"');
    expect(route).toContain('router.post("/gojek-connector/server-sync/drivers"');
    expect(route).toContain("getGojekServerConnectorHealth()");
    expect(route).toContain("fleet_gojek_connector_workers");
    expect(route).toContain("fleet_gojek_sync_jobs");
  });

  it("provides a non-mutating authenticated Gojek connector dry-run", () => {
    expect(route).toContain('router.post("/gojek-connector/dry-run"');
    expect(route).toContain("persisted: false");
    expect(route).toContain("database: \"ready\"");
    expect(route).toContain("detectGojekExportType");
  });

  it("exposes Gojek login only to authenticated bridge runtime", () => {
    expect(route).toContain('router.get("/gojek-connector/runtime-credentials"');
    expect(route).toContain("x-gojek-connector-secret");
    expect(route).toContain("Cache-Control");
    expect(route).toContain("GOJEK_LOGIN_EMAIL");
    expect(route).toContain("GOJEK_LOGIN_PASSWORD");
  });

  it("provides a guarded Gojek connector handoff without storing credentials", () => {
    expect(route).toContain('router.post("/gojek-connector/handoff"');
    expect(route).toContain("x-gojek-connector-secret");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("fileRetained: false");
    expect(route).toContain('router.get("/gojek-connector/status"');
    expect(route).not.toContain("GOJEK_USERNAME");
    expect(route).not.toContain("GOJEK_PASSWORD");
  });

  it("keeps Central Finance reads available while writes remain fail-closed", () => {
    const finance = readFileSync(resolve(process.cwd(), "src/lib/central-finance-client.ts"), "utf8");
    expect(finance).toContain("getFleetAccountingSettingsDirect");
    expect(finance).toContain("if (cfg.writeEnabled)");
    expect(finance).toContain("Central Finance service token wajib sebelum write diaktifkan.");
    expect(finance).toContain("assertCentralFinanceWriteEnabled");
  });
});
