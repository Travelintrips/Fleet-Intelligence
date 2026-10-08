import { createHash, createPublicKey, verify } from "node:crypto";
import type { Request } from "express";

const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAW5vY/51Dnnf/TpGxTChjZfiDJvSjIRkJeqEPy3IXA0c=
-----END PUBLIC KEY-----`;

function bodyText(req: Request): string {
  return JSON.stringify(req.body ?? {});
}

export function verifyGojekWorkerRequest(req: Request): { ok: true; workerId: string } | { ok: false; error: string } {
  try {
    const workerId = String(req.get("x-gojek-worker-id") ?? "").trim();
    const tsRaw = String(req.get("x-gojek-worker-ts") ?? "").trim();
    const signatureB64 = String(req.get("x-gojek-worker-signature") ?? "").trim();
    if (!workerId || !tsRaw || !signatureB64) {
      return { ok: false, error: "Worker signature headers tidak lengkap." };
    }

    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
      return { ok: false, error: "Worker signature timestamp tidak valid." };
    }

    const digest = createHash("sha256").update(bodyText(req)).digest("hex");
    const canonical = [req.method.toUpperCase(), req.path, tsRaw, digest].join("\n");
    const publicKeyPem = String(process.env.GOJEK_WORKER_PUBLIC_KEY_PEM ?? DEFAULT_PUBLIC_KEY).trim();
    const publicKey = createPublicKey(publicKeyPem);
    const valid = verify(null, Buffer.from(canonical), publicKey, Buffer.from(signatureB64, "base64"));
    if (!valid) return { ok: false, error: "Worker signature tidak valid." };
    return { ok: true, workerId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Worker signature gagal diverifikasi." };
  }
}
