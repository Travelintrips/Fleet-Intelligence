function required(value: unknown, name: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${name} belum dikonfigurasi.`);
  return v;
}

export function normalizeFleetPhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  return "62" + digits;
}

export async function sendFleetWa(args: { phone: string; message: string; idempotencyKey?: string }) {
  const baseUrl = required(process.env.CST_WA_GATEWAY_URL ?? process.env.WA_GATEWAY_URL, "CST_WA_GATEWAY_URL").replace(/\/$/, "");
  const token = required(process.env.CST_WA_GATEWAY_TOKEN ?? process.env.WA_GATEWAY_TOKEN, "CST_WA_GATEWAY_TOKEN");
  const phone = normalizeFleetPhone(args.phone);
  if (!phone) throw new Error("Nomor WhatsApp Fleet tidak valid.");
  const deviceId = String(process.env.FLEET_WA_DEVICE_ID ?? "").trim();

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(args.idempotencyKey ? { "Idempotency-Key": args.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      type: "text",
      to: phone,
      text: args.message,
      ...(deviceId ? { deviceId } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? payload.message ?? `WA Gateway HTTP ${response.status}`));
  return {
    messageId: String(payload.messageId ?? payload.id ?? payload.requestId ?? "") || null,
    senderDevice: deviceId || null,
    deviceStatus: String(payload.status ?? "") || null,
  };
}

export async function getFleetWaGatewayStatus() {
  const baseUrl = String(process.env.CST_WA_GATEWAY_URL ?? process.env.WA_GATEWAY_URL ?? "").trim().replace(/\/$/, "");
  const deviceId = String(process.env.FLEET_WA_DEVICE_ID ?? "").trim() || null;
  if (!baseUrl) {
    return { configured: false, gatewayHealthy: false, gatewayStatus: "UNCONFIGURED", deviceId, deviceStatus: null };
  }

  let gatewayHealthy = false;
  let gatewayStatus = "UNKNOWN";
  let deviceStatus: string | null = null;

  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8_000) });
    if (health.ok) {
      const payload = await health.json().catch(() => null) as Record<string, unknown> | null;
      gatewayHealthy = String(payload?.status ?? "").toLowerCase() === "ok";
      gatewayStatus = gatewayHealthy ? "OK" : String(payload?.status ?? "UNKNOWN").toUpperCase();
    } else {
      gatewayStatus = `HTTP_${health.status}`;
    }
  } catch {
    gatewayStatus = "UNREACHABLE";
  }

  if (deviceId) {
    try {
      const status = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(8_000) });
      if (status.ok) {
        const html = await status.text();
        const escaped = deviceId.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
        const match = html.match(new RegExp(`${escaped}[\\s\\S]{0,220}?<strong[^>]*>([^<]+)<\\/strong>`, "i"));
        deviceStatus = match?.[1]?.trim().toUpperCase() ?? null;
      }
    } catch {
      deviceStatus = null;
    }
  }

  return {
    configured: Boolean(baseUrl && (process.env.CST_WA_GATEWAY_TOKEN ?? process.env.WA_GATEWAY_TOKEN)?.trim()),
    gatewayHealthy,
    gatewayStatus,
    deviceId,
    deviceStatus,
  };
}
