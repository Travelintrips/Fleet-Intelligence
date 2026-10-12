import http from "node:http";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = String(process.env.FLEET_BASE_URL ?? "https://fleet.cstlogistic.co.id").replace(/\/$/, "");
const WORKER_ID = String(process.env.GOJEK_WORKER_ID ?? "srv1792369-gojek-01");
const VERSION = "2.1.1";
const PRIVATE_KEY_PATH = String(process.env.GOJEK_WORKER_PRIVATE_KEY ?? "/run/secrets/worker-private.pem");
const POLL_MS = Math.max(3000, Number(process.env.POLL_MS ?? 5000));
const PORT = Number(process.env.PORT ?? 8080);

const privateKey = createPrivateKey(await readFile(PRIVATE_KEY_PATH, "utf8"));
let busy = false;
let polling = false;
let failureCount = 0;
let nextPollAfter = 0;
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
    signal: AbortSignal.timeout(localPath === "/gojek-connector/worker/handoff" ? 900_000 : 90_000),
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
  const transactionJob = String(job.requested_by || "").startsWith("fleet-scheduler-transactions-");
  const exportPath = "/drivers?page=1&page_size=100";
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    await page.goto(`${portalUrl}${exportPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    await loginIfNeeded(page, credentials);

    if (!page.url().includes(transactionJob ? "/transactions" : "/drivers")) {
      await page.goto(`${portalUrl}${exportPath}`, {
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
      await page.goto(`${portalUrl}${exportPath}`, {
        waitUntil: "domcontentloaded", timeout: 45000,
      });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    }
    if (await needsLogin()) {
      throw new Error("Sesi Gojek belum terautentikasi setelah auto re-login. Selesaikan login resmi atau verifikasi tambahan.");
    }

    // Capture the official Gojek Overview metric for driver snapshot jobs.
    // Read only the visible Overview page; never infer earnings from fee transactions.
    let overview = null;
    if (!transactionJob) {
      try {
        await page.goto(`${portalUrl}/overview`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
        const overviewText = await page.locator("body").innerText();
        const earningMatch = overviewText.match(/Total\s+net\s+earnings\s*Rp\s*([\d.,]+)/i);
        const rangeInputs = await page.locator("input").evaluateAll((inputs) =>
          inputs.map((i) => i.value || i.getAttribute("value") || "").join(" "));
        const dateMatch = (overviewText + " " + rangeInputs).match(
          /(\d{4}-\d{2}-\d{2})\s*(?:to|s\/d|–|—)\s*(\d{4}-\d{2}-\d{2})/i
        );
        if (earningMatch && dateMatch) {
          const netEarnings = Number(earningMatch[1].replace(/\D/g, ""));
          if (Number.isFinite(netEarnings) && netEarnings >= 0) {
            const periodDays = (Date.parse(dateMatch[2] + 'T00:00:00Z') - Date.parse(dateMatch[1] + 'T00:00:00Z')) / 86400000;
            if (Number.isInteger(periodDays) && periodDays >= 0 && periodDays <= 366) {
              // Preserve the actual date range selected on Gojek, regardless of its length.
              overview = { netEarnings, periodStart: dateMatch[1], periodEnd: dateMatch[2] };
            } else {
              console.warn("Gojek Overview invalid date range; skipping Overview only.");
            }
          }
        }
        if (!overview) console.warn("Gojek Overview earnings or period not readable; retaining driver sync only.");
      } catch (error) {
        console.warn("Optional Gojek Overview capture failed; driver sync unaffected:",
          error instanceof Error ? error.message : String(error));
      }
      await page.goto(`${portalUrl}/drivers?page=1&page_size=100`,
        {waitUntil:"domcontentloaded",timeout:45000});
      await page.waitForLoadState("networkidle",{timeout:10000}).catch(() => undefined);
    }

    if (transactionJob) {
      await page.getByText("Reports", { exact:true }).first().click({ timeout:10000 });
      await page.getByPlaceholder("Select transaction type").click({timeout:10000});
      await page.getByText("Transaction History for Reconciliation",{exact:true}).last().click({timeout:10000});
      const jakartaDate = (offsetDays) => new Date(Date.now() + (7 * 3600000) - (offsetDays * 86400000)).toISOString().slice(0,10);
      const fromDate = jakartaDate(1);
      const toDate = jakartaDate(0);
      for (const [name,value] of [["date_from",fromDate],["date_to",toDate]]) {
        const field = page.locator('input[name="' + name + '"]');
        await field.fill(value);
        await field.press("Tab");
        if (await field.getAttribute("aria-invalid") === "true") {
          throw new Error("Gojek rejected transaction date " + name + "=" + value);
        }
      }
      if (!(await page.getByRole("button",{name:"Export"}).isEnabled())) {
        throw new Error("Gojek transaction Export disabled for " + fromDate + " to " + toDate);
      }
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
      throw new Error(`Tombol Export ${transactionJob ? "Transactions" : "Drivers"} tidak ditemukan. url=${url} title=${title} controls=${JSON.stringify(sample)}`);
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
    if (transactionJob) {
      if (!fileName.toLowerCase().endsWith(".csv")) throw new Error("Gojek exported unsupported file type: " + fileName);
      const header = csv.replace(/^\uFEFF/, "").split(/\r?\n/,1)[0]?.toLowerCase() || "";
      if (!header.includes("amount") || !header.includes("driver")) throw new Error("Export transaksi tidak memiliki kolom Driver dan Amount; CSV tidak diimpor.");
      if (header.includes("rental fee") && header.includes("license plate")) throw new Error("Export berisi snapshot driver, bukan transaksi; CSV tidak diimpor.");
    }

    return await post("/gojek-connector/worker/handoff", {
      jobId: job.id,
      fileName,
      content: csv,
      ...(overview ? { overview } : {}),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function tick() {
  if (busy || polling || Date.now() < nextPollAfter) return;
  polling = true;
  try {
    const claim = await post("/gojek-connector/worker/claim", { version: VERSION });
    failureCount = 0;
    nextPollAfter = 0;
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
    // Back off transient CDN/auth failures to prevent overlapping claims and request storms.
    failureCount = Math.min(failureCount + 1, 6);
    nextPollAfter = Date.now() + Math.min(60000, 5000 * (2 ** (failureCount - 1)));
    last = { at: new Date().toISOString(), status: "poll-error", httpStatus: status, error: message, retryAfter: new Date(nextPollAfter).toISOString() };
  } finally {
    polling = false;
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
