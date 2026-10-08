import http from "node:http";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = String(process.env.FLEET_BASE_URL ?? "https://fleet.cstlogistic.co.id").replace(/\/$/, "");
const WORKER_ID = String(process.env.GOJEK_WORKER_ID ?? "srv1792369-gojek-01");
const VERSION = "2.0.0";
const PRIVATE_KEY_PATH = String(process.env.GOJEK_WORKER_PRIVATE_KEY ?? "/run/secrets/worker-private.pem");
const POLL_MS = Math.max(3000, Number(process.env.POLL_MS ?? 5000));
const PORT = Number(process.env.PORT ?? 8080);

const privateKey = createPrivateKey(await readFile(PRIVATE_KEY_PATH, "utf8"));
let busy = false;
let last = null;

function signedHeaders(method, canonicalPath, body) {
  const ts = String(Date.now());
  const bodyText = JSON.stringify(body ?? {});
  const digest = createHash("sha256").update(bodyText).digest("hex");
  const canonical = [method.toUpperCase(), canonicalPath, ts, digest].join("\n");
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64");
  return {
    "content-type": "application/json",
    "x-gojek-worker-id": WORKER_ID,
    "x-gojek-worker-ts": ts,
    "x-gojek-worker-signature": signature,
  };
}

async function post(localPath, body) {
  const actualPath = "/api/logistics/fleet" + localPath;
  const response = await fetch(BASE + actualPath, {
    method: "POST",
    headers: signedHeaders("POST", localPath, body),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loginIfNeeded(page, credentials) {
  const email = page.locator('input[name="email"], input[type="email"]').first();
  const password = page.locator('input[name="password"], input[type="password"]').first();

  const loginAppeared = await email.waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false);

  if (!loginAppeared && !page.url().includes('/login')) return;

  if (!loginAppeared) {
    await email.waitFor({ state: 'visible', timeout: 15000 });
  }
  await password.waitFor({ state: 'visible', timeout: 15000 });

  await email.fill(credentials.email);
  await password.fill(credentials.password);

  const submit = page.locator('button:has-text("Log in"), button:has-text("Login"), button[type="submit"], input[type="submit"]').first();
  await submit.waitFor({ state: 'visible', timeout: 10000 });

  const authResponsePromise = page.waitForResponse(
    (response) => /\/api\/api\/v1\/auth\/login/.test(response.url()),
    { timeout: 20000 }
  ).catch(() => null);

  await submit.click();
  const authResponse = await authResponsePromise;
  if (!authResponse) {
    throw new Error('Request login Gojek tidak terdeteksi setelah tombol Log in ditekan.');
  }

  const status = authResponse.status();
  let success = null;
  let apiMessage = '';
  try {
    const payload = await authResponse.json();
    success = typeof payload?.success === 'boolean' ? payload.success : null;
    apiMessage = String(payload?.error?.message ?? payload?.message ?? '').slice(0,500);
  } catch {}

  if (status < 200 || status >= 300 || success === false) {
    throw new Error(`Login Gojek ditolak. HTTP ${status}${apiMessage ? `: ${apiMessage}` : ''}`);
  }

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(2500);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/captcha|verification|verify|otp|one-time|kode verifikasi|security check/i.test(bodyText)) {
    throw new Error('Gojek meminta verifikasi tambahan. Sinkronisasi dihentikan untuk penyelesaian manual.');
  }

  if (page.url().includes('/login')) {
    const messages = bodyText.split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0,60);
    throw new Error(`Login Gojek API HTTP ${status} tetapi sesi browser kembali ke login. messages=${JSON.stringify(messages)}`);
  }
}

async function syncJob(payload) {
  const { job, credentials, portalUrl } = payload;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    await page.goto(`${portalUrl}/drivers?page=1&page_size=100`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    await loginIfNeeded(page, credentials);

    if (!page.url().includes("/drivers")) {
      await page.goto(`${portalUrl}/drivers?page=1&page_size=100`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);

    // A Gojek session can expire between navigation and export. Retry login
    // once, using the existing official login form, without bypassing OTP/CAPTCHA.
    const needsLogin = async () =>
      /\/login(?:[/?#]|$)/i.test(new URL(page.url()).pathname) ||
      await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (await needsLogin()) {
      await loginIfNeeded(page, credentials);
      await page.goto(`${portalUrl}/drivers?page=1&page_size=100`, {
        waitUntil: "domcontentloaded", timeout: 45000,
      });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    }
    if (await needsLogin()) {
      throw new Error("Sesi Gojek belum terautentikasi setelah auto re-login. Selesaikan login resmi atau verifikasi tambahan.");
    }

    const exportButton = page.locator(
      'button:has-text("Export"), a:has-text("Export"), [role="button"]:has-text("Export")'
    ).first();

    if (!(await exportButton.isVisible().catch(() => false))) {
      const title = await page.title().catch(() => "");
      const url = page.url();
      const buttons = await page.locator('button, a, [role="button"]').allTextContents().catch(() => []);
      const sample = buttons.map((x) => x.trim()).filter(Boolean).slice(0, 80);
      await page.screenshot({ path: "/tmp/gojek-export-missing.png", fullPage: true }).catch(() => undefined);
      throw new Error(`Tombol Export Drivers tidak ditemukan. url=${url} title=${title} controls=${JSON.stringify(sample)}`);
    }

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 45_000 }),
      exportButton.click(),
    ]);

    const fileName = download.suggestedFilename() || `gojek-drivers-${Date.now()}.csv`;
    const path = await download.path();
    if (!path) throw new Error("File export Gojek tidak tersedia.");

    const csv = await readFile(path, "utf8");
    if (!csv.trim()) throw new Error("File export Gojek kosong.");

    return await post("/gojek-connector/worker/handoff", {
      jobId: job.id,
      fileName,
      content: csv,
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function tick() {
  if (busy) return;
  try {
    const claim = await post("/gojek-connector/worker/claim", { version: VERSION });
    if (!claim.job) {
      last = { at: new Date().toISOString(), status: "idle" };
      return;
    }

    busy = true;
    last = { at: new Date().toISOString(), status: "running", jobId: claim.job.id };
    try {
      const result = await syncJob(claim);
      last = { at: new Date().toISOString(), status: "succeeded", jobId: claim.job.id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      last = { at: new Date().toISOString(), status: "failed", jobId: claim.job.id, error: message };
      await post("/gojek-connector/worker/fail", {
        jobId: claim.job.id,
        error: message,
      }).catch(() => undefined);
    } finally {
      busy = false;
    }
  } catch (error) {
    const status = error?.status;
    const message = error instanceof Error ? error.message : String(error);
    last = { at: new Date().toISOString(), status: "poll-error", httpStatus: status, error: message };
  }
}

const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, service: "cst-gojek-vps-worker", workerId: WORKER_ID, version: VERSION, busy, last }));
});
server.listen(PORT, "0.0.0.0");

setInterval(() => void tick(), POLL_MS);
void tick();

console.log(`CST Gojek VPS worker ${VERSION} started as ${WORKER_ID}`);
