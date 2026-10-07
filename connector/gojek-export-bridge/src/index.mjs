import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} wajib diisi.`);
  return value;
}

const portalUrl = String(process.env.GOJEK_FLEET_PORTAL_URL ?? "https://fleetpartner.gojek.com").trim();
const parsedPortal = new URL(portalUrl);
const allowedHost = String(process.env.GOJEK_CONNECTOR_ALLOWED_HOST ?? "fleetpartner.gojek.com").trim();
if (parsedPortal.protocol !== "https:" || parsedPortal.hostname !== allowedHost) {
  throw new Error("Portal Gojek wajib HTTPS dan host harus sesuai allowlist.");
}

const fleetBaseUrl = required("FLEET_BASE_URL").replace(/\/$/, "");
const sharedSecret = required("GOJEK_CONNECTOR_SHARED_SECRET");

async function fetchRuntimeCredentials() {
  const response = await fetch(`${fleetBaseUrl}/api/logistics/fleet/gojek-connector/runtime-credentials`, {
    method: "GET",
    headers: { "x-gojek-connector-secret": sharedSecret },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Credential endpoint HTTP ${response.status}`);
  }
  const email = String(payload.email ?? "").trim();
  const password = String(payload.password ?? "");
  return email && password ? { email, password } : null;
}

let runtimeCredentials = null;

const maxFileMb = Math.min(Math.max(Number(process.env.GOJEK_CONNECTOR_MAX_FILE_MB ?? 10) || 10, 1), 12);
const controlPort = Math.min(Math.max(Number(process.env.GOJEK_BRIDGE_CONTROL_PORT ?? 17891) || 17891, 1024), 65535);
const tempDir = await mkdtemp(path.join(os.tmpdir(), "cst-gojek-export-"));

console.log("CST Gojek Export Bridge");
console.log("Mode: interactive official export");
console.log(`Portal: ${portalUrl}`);
console.log(`Fleet receiver: ${fleetBaseUrl}/api/logistics/fleet/gojek-connector/handoff`);
console.log("Tidak ada credential Gojek yang disimpan. Login/OTP dilakukan manual di browser.");
console.log("Jika portal menolak browser automation, hentikan proses dan jangan mencoba bypass.");

const browser = await chromium.launch({
  headless: false,
  downloadsPath: tempDir,
});

const context = await browser.newContext({
  acceptDownloads: true,
});

let page = await context.newPage();

async function maybeAutoLogin(targetPage) {
  if (!runtimeCredentials) {
    runtimeCredentials = await fetchRuntimeCredentials().catch((error) => {
      console.warn("Credential runtime belum tersedia:", error instanceof Error ? error.message : error);
      return null;
    });
  }
  if (!runtimeCredentials) return false;

  const email = targetPage.locator(
    'input[type="email"], input[name*="email" i], input[autocomplete="username"]'
  ).first();
  const password = targetPage.locator(
    'input[type="password"], input[name*="password" i], input[autocomplete="current-password"]'
  ).first();

  const emailVisible = await email.isVisible().catch(() => false);
  const passwordVisible = await password.isVisible().catch(() => false);
  if (!emailVisible || !passwordVisible) return false;

  await email.fill(runtimeCredentials.email);
  await password.fill(runtimeCredentials.password);

  const submit = targetPage.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Masuk"), button:has-text("Sign in")'
  ).first();

  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
    console.log("Login form diisi dan dikirim menggunakan credential lokal terenkripsi.");
  } else {
    console.log("Credential sudah diisi. Tombol login tidak dikenali; silakan klik manual.");
  }
  return true;
}

async function ensurePortalOpen() {
  if (page.isClosed()) page = await context.newPage();
  await page.bringToFront();
  const current = page.url();
  if (!current || current === "about:blank" || !current.startsWith("https://fleetpartner.gojek.com")) {
    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await maybeAutoLogin(page).catch((error) => {
    console.warn("Autofill login tidak berhasil:", error instanceof Error ? error.message : error);
  });
}

async function handoffDownload(download) {
  const suggested = download.suggestedFilename() || "gojek-export.csv";
  if (!suggested.toLowerCase().endsWith(".csv")) {
    console.warn(`Download diabaikan karena bukan CSV: ${suggested}`);
    return;
  }

  const failure = await download.failure();
  if (failure) {
    console.error(`Download gagal: ${failure}`);
    return;
  }

  const savedPath = await download.path();
  if (!savedPath) {
    console.error("Path download sementara tidak tersedia.");
    return;
  }

  try {
    const data = await readFile(savedPath);
    if (data.byteLength > maxFileMb * 1024 * 1024) {
      throw new Error(`File melebihi batas ${maxFileMb} MB.`);
    }

    const response = await fetch(`${fleetBaseUrl}/api/logistics/fleet/gojek-connector/handoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gojek-connector-secret": sharedSecret,
      },
      body: JSON.stringify({
        fileName: suggested,
        content: data.toString("utf8"),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? `Fleet handoff HTTP ${response.status}`);
    }

    console.log(
      `Import sukses: report #${payload.reportId}, raw=${payload.rawInserted}, normalized=${payload.successRows}, failed=${payload.failedRows}`,
    );
  } finally {
    await rm(savedPath, { force: true }).catch(() => undefined);
  }
}

context.on("page", (p) => {
  p.on("download", (download) => {
    void handoffDownload(download).catch((error) => {
      console.error("Handoff export gagal:", error instanceof Error ? error.message : error);
    });
  });
});

page.on("download", (download) => {
  void handoffDownload(download).catch((error) => {
    console.error("Handoff export gagal:", error instanceof Error ? error.message : error);
  });
});

const controlServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://fleet.cstlogistic.co.id");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, bridge: "cst-gojek-export-bridge", portalHost: allowedHost }));
    return;
  }

  if (req.method === "POST" && req.url === "/open") {
    void ensurePortalOpen()
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Gagal membuka portal." }));
      });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

controlServer.listen(controlPort, "127.0.0.1", () => {
  console.log(`Local bridge control: http://127.0.0.1:${controlPort}`);
});

await ensurePortalOpen();

console.log("");
console.log("Browser sudah dibuka.");
console.log("1. Bridge akan mencoba login otomatis menggunakan secret Hostinger.");
console.log("2. Pilih report yang dibutuhkan.");
console.log("3. Klik tombol Export/Download resmi.");
console.log("4. Bridge akan menangkap file sementara, mengirimnya ke CST Fleet, lalu menghapusnya.");
console.log("");
console.log("Tekan Ctrl+C untuk berhenti.");

const shutdown = async () => {
  await new Promise((resolve) => controlServer.close(() => resolve())).catch(() => undefined);
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await new Promise(() => {});
