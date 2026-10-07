import http from "node:http";
import { chromium } from "playwright";

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} wajib diisi.`);
  return value;
}

const port = Number(process.env.PORT ?? 8080);
const fleetBaseUrl = required("FLEET_BASE_URL").replace(/\/$/, "");
const connectorSecret = required("GOJEK_CONNECTOR_SHARED_SECRET");
const serviceToken = String(process.env.GOJEK_SERVER_CONNECTOR_TOKEN ?? connectorSecret).trim();
const portalUrl = String(process.env.GOJEK_FLEET_PORTAL_URL ?? "https://fleetpartner.gojek.com").trim();
const allowedHost = String(process.env.GOJEK_CONNECTOR_ALLOWED_HOST ?? "fleetpartner.gojek.com").trim();

const parsedPortal = new URL(portalUrl);
if (parsedPortal.protocol !== "https:" || parsedPortal.hostname !== allowedHost) {
  throw new Error("Portal Gojek wajib HTTPS dan host harus sesuai allowlist.");
}

let running = false;
let lastRun = null;

async function fetchRuntimeCredentials() {
  const response = await fetch(`${fleetBaseUrl}/api/logistics/fleet/gojek-connector/runtime-credentials`, {
    method: "GET",
    headers: { "x-gojek-connector-secret": connectorSecret },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Credential endpoint HTTP ${response.status}`);
  const email = String(payload.email ?? "").trim();
  const password = String(payload.password ?? "");
  if (!email || !password) throw new Error("Credential Gojek belum tersedia.");
  return { email, password };
}

async function handoffCsv(fileName, content) {
  const response = await fetch(`${fleetBaseUrl}/api/logistics/fleet/gojek-connector/handoff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-gojek-connector-secret": connectorSecret,
    },
    body: JSON.stringify({ fileName, content }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Fleet handoff HTTP ${response.status}`);
  return payload;
}

async function loginIfNeeded(page) {
  const credentials = await fetchRuntimeCredentials();

  const email = page.locator(
    'input[type="email"], input[name*="email" i], input[autocomplete="username"]'
  ).first();
  const password = page.locator(
    'input[type="password"], input[name*="password" i], input[autocomplete="current-password"]'
  ).first();

  if (await email.isVisible().catch(() => false)) {
    await email.fill(credentials.email);
  }
  if (await password.isVisible().catch(() => false)) {
    await password.fill(credentials.password);
  }

  if ((await email.isVisible().catch(() => false)) || (await password.isVisible().catch(() => false))) {
    const submit = page.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Masuk"), button:has-text("Sign in")'
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
    'text=/captcha|verification|verify|otp|one-time|kode verifikasi|security check/i'
  ).first();
  if (await challenge.isVisible().catch(() => false)) {
    throw new Error("Gojek meminta verifikasi tambahan. Sinkronisasi dihentikan untuk penyelesaian manual.");
  }
}

async function syncDrivers() {
  const browser = await chromium.launch({ headless: true });
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
      'button:has-text("Export"), a:has-text("Export"), [role="button"]:has-text("Export")'
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
    const content = await readFile(path, "utf8");
    if (!content.trim()) throw new Error("File export Gojek kosong.");

    return await handoffCsv(fileName, content);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function authorized(req) {
  const token = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  return token && token === serviceToken;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      service: "cst-gojek-server-connector",
      busy: running,
      lastRun,
      portalHost: allowedHost,
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/sync/drivers") {
    if (!authorized(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (running) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: "Sync sedang berjalan." }));
      return;
    }

    running = true;
    const startedAt = new Date().toISOString();
    try {
      const result = await syncDrivers();
      lastRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: true,
        type: "drivers",
        result,
      };
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: false,
        type: "drivers",
        error: message,
      };
      res.writeHead(500);
      res.end(JSON.stringify({ error: message }));
    } finally {
      running = false;
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Gojek server connector listening on :${port}`);
});
