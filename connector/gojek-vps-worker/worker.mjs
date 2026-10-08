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
  const response = await fetch(BASE + "/api/logistics/fleet" + localPath, {
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
  const email = page.locator(
    'input[type="email"], input[name*="email" i], input[autocomplete="username"]'
  ).first();
  const password = page.locator(
    'input[type="password"], input[name*="password" i], input[autocomplete="current-password"]'
  ).first();

  if (await email.isVisible().catch(() => false)) await email.fill(credentials.email);
  if (await password.isVisible().catch(() => false)) await password.fill(credentials.password);

  if ((await email.isVisible().catch(() => false)) || (await password.isVisible().catch(() => false))) {
    const submit = page.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Masuk"), button:has-text("Sign in")'
    ).first();
    if (!(await submit.isVisible().catch(() => false))) {
      throw new Error("Form login ditemukan tetapi tombol login tidak dikenali.");
    }
    await submit.click();
    // Login may navigate asynchronously (SPA/SSO); do not continue to export
    // while the portal is still displaying the login form.
    await page.waitForURL(url => !/\\/login(?:[/?#]|$)/i.test(url.pathname), {
      timeout: 20_000,
    }).catch(() => undefined);
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/captcha|verification|verify|otp|one-time|kode verifikasi|security check/i.test(bodyText)) {
    throw new Error("Gojek meminta verifikasi tambahan. Sinkronisasi dihentikan untuk penyelesaian manual.");
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

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

    const loginFormVisible = await page.locator(
      'input[type="password"], input[autocomplete="current-password"], button:has-text("Log in")'
    ).first().isVisible().catch(() => false);
    if (/\\/login(?:[/?#]|$)/i.test(new URL(page.url()).pathname) || loginFormVisible) {
      throw new Error("Login Fleet Partner Gojek belum berhasil. Periksa kredensial atau selesaikan verifikasi resmi Gojek sebelum Sync Drivers.");
    }

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
    last = {
      at: new Date().toISOString(),
      status: "poll-error",
      httpStatus: error?.status,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    ok: true,
    service: "cst-gojek-vps-worker",
    workerId: WORKER_ID,
    version: VERSION,
    busy,
    last,
  }));
}).listen(PORT, "0.0.0.0");

setInterval(() => void tick(), POLL_MS);
void tick();
console.log(`CST Gojek VPS worker ${VERSION} started as ${WORKER_ID}`);
