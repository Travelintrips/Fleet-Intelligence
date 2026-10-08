import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  puppeteer: typeof import("puppeteer-core");
  portableChromium: typeof import("@sparticuz/chromium").default;
}> | null = null;

async function getBrowserRuntime() {
  runtimePromise ??= Promise.all([
    import("puppeteer-core"),
    import("@sparticuz/chromium"),
  ]).then(([puppeteer, sparticuz]) => ({
    puppeteer,
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

  const connectorSecret = String(
    process.env.GOJEK_CONNECTOR_SHARED_SECRET ?? ""
  ).trim();

  const portalUrl = String(
    process.env.GOJEK_FLEET_PORTAL_URL ?? "https://fleetpartner.gojek.com"
  ).trim();

  const allowedHost = String(
    process.env.GOJEK_CONNECTOR_ALLOWED_HOST ?? "fleetpartner.gojek.com"
  ).trim();

  if (!connectorSecret) {
    throw new Error("GOJEK_CONNECTOR_SHARED_SECRET wajib diisi.");
  }

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
  if (!email || !password) {
    throw new Error("Credential Gojek belum tersedia.");
  }

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

async function visibleSelector(page: any, selectors: string[]) {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) continue;
    const visible = await handle.evaluate((el: Element) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0;
    }).catch(() => false);
    if (visible) return handle;
  }
  return null;
}

async function loginIfNeeded(page: any) {
  const credentials = await fetchRuntimeCredentials();

  const email = await visibleSelector(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[autocomplete="username"]',
  ]);

  const password = await visibleSelector(page, [
    'input[type="password"]',
    'input[name*="password" i]',
    'input[autocomplete="current-password"]',
  ]);

  if (email) {
    await email.click({ clickCount: 3 }).catch(() => undefined);
    await email.type(credentials.email);
  }

  if (password) {
    await password.click({ clickCount: 3 }).catch(() => undefined);
    await password.type(credentials.password);
  }

  if (email || password) {
    let submit = await visibleSelector(page, [
      'button[type="submit"]',
      'input[type="submit"]',
    ]);

    if (!submit) {
      const candidates = await page.$$('button, [role="button"], a');
      for (const candidate of candidates) {
        const text = await candidate.evaluate((el: Element) =>
          (el.textContent ?? "").trim().toLowerCase()
        ).catch(() => "");
        if (/^(login|masuk|sign in)$/.test(text)) {
          submit = candidate;
          break;
        }
      }
    }

    if (!submit) {
      throw new Error("Form login ditemukan tetapi tombol login tidak dikenali.");
    }

    await submit.click();
    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
  }

  const bodyText = await page.$eval("body", (el: Element) =>
    (el.textContent ?? "").toLowerCase()
  ).catch(() => "");

  if (/captcha|verification|verify|otp|one-time|kode verifikasi|security check/i.test(bodyText)) {
    throw new Error(
      "Gojek meminta verifikasi tambahan. Sinkronisasi dihentikan untuk penyelesaian manual.",
    );
  }
}

async function findExportButton(page: any) {
  const candidates = await page.$$('button, a, [role="button"]');
  for (const candidate of candidates) {
    const text = await candidate.evaluate((el: Element) =>
      (el.textContent ?? "").trim()
    ).catch(() => "");
    if (/\bexport\b/i.test(text)) {
      const visible = await candidate.evaluate((el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0;
      }).catch(() => false);
      if (visible) return candidate;
    }
  }
  return null;
}

async function waitForDownloadedCsv(downloadDir: string, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const files = await readdir(downloadDir).catch(() => []);
    const completed = files.find((name) =>
      !name.endsWith(".crdownload") &&
      !name.endsWith(".tmp") &&
      name.toLowerCase().endsWith(".csv")
    );
    if (completed) return completed;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("File export Gojek tidak selesai diunduh.");
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
    runtime: "hostinger-native-puppeteer-portable-chromium",
    executablePath: executable,
    browsersPath: "portable",
    engine: "puppeteer-core",
    error,
  };
}

export async function syncNativeGojekDrivers() {
  if (running) {
    throw new Error("Sync sedang berjalan.");
  }

  running = true;
  const startedAt = new Date().toISOString();
  let downloadDir: string | null = null;

  try {
    const { portalUrl } = getConfig();
    const { puppeteer, portableChromium } = await getBrowserRuntime();
    const executablePath = await portableChromium.executablePath();

    if (!executablePath || !existsSync(executablePath)) {
      throw new Error(`Portable Chromium tidak ditemukan: ${executablePath ?? "unknown"}`);
    }

    downloadDir = await mkdtemp(join(tmpdir(), "cst-gojek-download-"));

    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: portableChromium.args,
      defaultViewport: { width: 1440, height: 1000 },
    });

    try {
      const page = await browser.newPage();

      const client = await page.createCDPSession();
      await client.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
      });

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

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const exportButton = await findExportButton(page);
      if (!exportButton) {
        throw new Error("Tombol Export Drivers tidak ditemukan pada portal Gojek.");
      }

      await exportButton.click();
      const fileName = await waitForDownloadedCsv(downloadDir);
      const filePath = join(downloadDir, fileName);
      const csv = await readFile(filePath, "utf8");

      if (!csv.trim()) {
        throw new Error("File export Gojek kosong.");
      }

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
    if (downloadDir) {
      await rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
