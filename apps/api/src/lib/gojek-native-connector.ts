import { existsSync } from "node:fs";

type LastRun = {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  type: "drivers";
  result?: unknown;
  error?: string;
};

let running = false;
let lastRun: LastRun | null = null;

let runtimePromise: Promise<{
  playwrightChromium: typeof import("playwright-core").chromium;
  portableChromium: typeof import("@sparticuz/chromium").default;
}> | null = null;

async function getBrowserRuntime() {
  runtimePromise ??= Promise.all([
    import("playwright-core"),
    import("@sparticuz/chromium"),
  ]).then(([playwright, sparticuz]) => ({
    playwrightChromium: playwright.chromium,
    portableChromium: sparticuz.default,
  }));
  return runtimePromise;
}

function getConfig() {
  const fleetBaseUrl = String(
    process.env.FLEET_PUBLIC_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    "https://fleet.cstlogistic.co.id"
  ).trim().replace(/\/$/, "");
  const connectorSecret = String(process.env.GOJEK_CONNECTOR_SHARED_SECRET ?? "").trim();
  const portalUrl = String(
    process.env.GOJEK_FLEET_PORTAL_URL ?? "https://fleetpartner.gojek.com"
  ).trim();
  const allowedHost = String(
    process.env.GOJEK_CONNECTOR_ALLOWED_HOST ?? "fleetpartner.gojek.com"
  ).trim();

  if (!connectorSecret) throw new Error("GOJEK_CONNECTOR_SHARED_SECRET wajib diisi.");

  const parsedPortal = new URL(portalUrl);
  if (parsedPortal.protocol !== "https:" || parsedPortal.hostname !== allowedHost) {
    throw new Error("Portal Gojek wajib HTTPS dan host harus sesuai allowlist.");
  }

  return { fleetBaseUrl, connectorSecret, portalUrl, allowedHost };
}

async function fetchRuntimeCredentials() {
  const { fleetBaseUrl, connectorSecret } = getConfig();
  const response = await fetch(
    `${fleetBaseUrl}/api/logistics/fleet/gojek-connector/runtime-credentials`,
    {
      headers: { "x-gojek-connector-secret": connectorSecret },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Credential endpoint HTTP ${response.status}`));
  }
  const email = String(payload.email ?? "").trim();
  const password = String(payload.password ?? "");
  if (!email || !password) throw new Error("Credential Gojek belum tersedia.");
  return { email, password };
}

async function handoffCsv(fileName: string, content: string) {
  const { fleetBaseUrl, connectorSecret } = getConfig();
  const response = await fetch(
    `${fleetBaseUrl}/api/logistics/fleet/gojek-connector/handoff`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gojek-connector-secret": connectorSecret,
      },
      body: JSON.stringify({ fileName, content }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Fleet handoff HTTP ${response.status}`));
  }
  return payload;
}

async function loginIfNeeded(page: any) {
  const credentials = await fetchRuntimeCredentials();
  const email = page.locator(
    'input[type="email"], input[name*="email" i], input[autocomplete="username"]',
  ).first();
  const password = page.locator(
    'input[type="password"], input[name*="password" i], input[autocomplete="current-password"]',
  ).first();

  if (await email.isVisible().catch(() => false)) await email.fill(credentials.email);
  if (await password.isVisible().catch(() => false)) await password.fill(credentials.password);

  if (
    (await email.isVisible().catch(() => false)) ||
    (await password.isVisible().catch(() => false))
  ) {
    const submit = page.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Masuk"), button:has-text("Sign in")',
    ).first();
    if (!(await submit.isVisible().catch(() => false))) {
      throw new Error("Form login ditemukan tetapi tombol login tidak dikenali.");
    }
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      submit.click(),
    ]);
  }

  const challenge = page.locator(
    'text=/captcha|verification|verify|otp|one-time|kode verifikasi|security check/i',
  ).first();
  if (await challenge.isVisible().catch(() => false)) {
    throw new Error(
      "Gojek meminta verifikasi tambahan. Sinkronisasi dihentikan untuk penyelesaian manual.",
    );
  }
}

export async function getNativeGojekConnectorHealth() {
  let configured = true;
  let browserReady = false;
  let error: string | null = null;
  let executable: string | null = null;

  try {
    getConfig();
    const { portableChromium } = await getBrowserRuntime();
    executable = await portableChromium.executablePath();
    browserReady = Boolean(executable && existsSync(executable));
    if (!browserReady) {
      error = `Portable Chromium belum siap. Expected: ${executable ?? "unknown"}`;
    }
  } catch (e) {
    configured = false;
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    configured,
    healthy: configured && browserReady,
    browserReady,
    busy: running,
    lastRun,
    service: "cst-gojek-native-connector",
    runtime: "hostinger-native-portable-chromium",
    executablePath: executable,
    browsersPath: "portable",
    error,
  };
}

export async function syncNativeGojekDrivers() {
  if (running) throw new Error("Sync sedang berjalan.");

  running = true;
  const startedAt = new Date().toISOString();

  try {
    const { portalUrl } = getConfig();
    const { playwrightChromium, portableChromium } = await getBrowserRuntime();
    const executablePath = await portableChromium.executablePath();
    const browser = await playwrightChromium.launch({
      executablePath,
      headless: true,
      args: portableChromium.args,
    });

    try {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();

      await page.goto(`${portalUrl}/drivers?page=1&page_size=100`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });

      await loginIfNeeded(page);

      if (!page.url().includes("/drivers")) {
        await page.goto(`${portalUrl}/drivers?page=1&page_size=100`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
      }

      await page.waitForLoadState("networkidle").catch(() => undefined);

      const exportButton = page.locator(
        'button:has-text("Export"), a:has-text("Export"), [role="button"]:has-text("Export")',
      ).first();

      if (!(await exportButton.isVisible().catch(() => false))) {
        throw new Error("Tombol Export Drivers tidak ditemukan pada portal Gojek.");
      }

      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 45_000 }),
        exportButton.click(),
      ]);

      const fileName = download.suggestedFilename() || `gojek-drivers-${Date.now()}.csv`;
      const path = await download.path();
      if (!path) throw new Error("File export Gojek tidak tersedia.");

      const { readFile } = await import("node:fs/promises");
      const csv = await readFile(path, "utf8");
      if (!csv.trim()) throw new Error("File export Gojek kosong.");

      const result = await handoffCsv(fileName, csv);
      lastRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: true,
        type: "drivers",
        result,
      };
      return result;
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      type: "drivers",
      error: message,
    };
    throw error;
  } finally {
    running = false;
  }
}
