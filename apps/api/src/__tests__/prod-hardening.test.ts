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

  it("uses the strictly above Rp50k WA reminder threshold", () => {
    const reminder = readFileSync(resolve(process.cwd(), "src/lib/fleet-wa-reminder.ts"), "utf8");
    expect(reminder).toContain("o.outstanding_amount > $3");
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
    expect(alertEngine).toContain("outstanding_amount >= 500000");
    expect(alertEngine).toContain("last_active_date <= CURRENT_DATE - 7");
    expect(alertEngine).toContain("dropPct > 15");
    expect(alertEngine).toContain("auto_resolved_at=now()");
    expect(route).toContain("syncFleetAlertsForCompany(cid)");
    expect(serverEntry).toContain("runFleetAlertSweep()");
  });

  it("keeps Central Finance reads available while writes remain fail-closed", () => {
    const finance = readFileSync(resolve(process.cwd(), "src/lib/central-finance-client.ts"), "utf8");
    expect(finance).toContain("getFleetAccountingSettingsDirect");
    expect(finance).toContain("if (cfg.writeEnabled)");
    expect(finance).toContain("Central Finance service token wajib sebelum write diaktifkan.");
    expect(finance).toContain("assertCentralFinanceWriteEnabled");
  });
});
