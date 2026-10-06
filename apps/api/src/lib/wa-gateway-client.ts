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
  const deviceId = required(process.env.FLEET_WA_DEVICE_ID, "FLEET_WA_DEVICE_ID");

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
  const token = String(process.env.CST_WA_GATEWAY_TOKEN ?? process.env.WA_GATEWAY_TOKEN ?? "").trim();
  const deviceId = String(process.env.FLEET_WA_DEVICE_ID ?? "").trim() || null;

  if (!baseUrl || !token || !deviceId) {
    return {
      configured: false,
      gatewayHealthy: false,
      gatewayStatus: !baseUrl ? "UNCONFIGURED_URL" : !token ? "UNCONFIGURED_TOKEN" : "UNCONFIGURED_DEVICE",
      deviceId,
      deviceStatus: null,
      visibleDevices: [],
    };
  }

  let gatewayHealthy = false;
  let gatewayStatus = "UNKNOWN";
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

  let deviceStatus: string | null = null;
  let visibleDevices: Array<{
    deviceId: string;
    name: string | null;
    status: string;
    enabled: boolean;
    lastHeartbeatAt: string | null;
  }> = [];

  try {
    const response = await fetch(`${baseUrl}/v1/devices`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null) as {
        devices?: Array<Record<string, unknown>>;
      } | null;
      visibleDevices = Array.isArray(payload?.devices)
        ? payload!.devices!.map((device) => ({
            deviceId: String(device.deviceId ?? ""),
            name: device.name == null ? null : String(device.name),
            status: String(device.status ?? "UNKNOWN").toUpperCase(),
            enabled: device.enabled !== false,
            lastHeartbeatAt: device.lastHeartbeatAt == null ? null : String(device.lastHeartbeatAt),
          })).filter((device) => Boolean(device.deviceId))
        : [];
      const selected = visibleDevices.find((device) => device.deviceId === deviceId);
      deviceStatus = selected
        ? selected.enabled ? selected.status : "DISABLED"
        : "NOT_ASSIGNED";
    } else if (response.status === 401 || response.status === 403) {
      deviceStatus = "TOKEN_FORBIDDEN";
    } else {
      deviceStatus = `HTTP_${response.status}`;
    }
  } catch {
    deviceStatus = "UNREACHABLE";
  }

  return {
    configured: true,
    gatewayHealthy,
    gatewayStatus,
    deviceId,
    deviceStatus,
    visibleDevices,
  };
}

