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

type FleetGatewayDevice = {
  deviceId: string;
  name: string | null;
  status: string;
  enabled: boolean;
  lastHeartbeatAt: string | null;
};

function gatewayConfig() {
  return {
    baseUrl: String(process.env.CST_WA_GATEWAY_URL ?? process.env.WA_GATEWAY_URL ?? "").trim().replace(/\/$/, ""),
    token: String(process.env.CST_WA_GATEWAY_TOKEN ?? process.env.WA_GATEWAY_TOKEN ?? "").trim(),
    configuredDeviceId: String(process.env.FLEET_WA_DEVICE_ID ?? "").trim() || null,
  };
}

async function listFleetGatewayDevices(baseUrl: string, token: string): Promise<{
  ok: boolean;
  statusCode: number;
  devices: FleetGatewayDevice[];
}> {
  const response = await fetch(`${baseUrl}/v1/devices`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    return { ok: false, statusCode: response.status, devices: [] };
  }
  const payload = await response.json().catch(() => null) as {
    devices?: Array<Record<string, unknown>>;
  } | null;
  const devices = Array.isArray(payload?.devices)
    ? payload!.devices!.map((device) => ({
        deviceId: String(device.deviceId ?? ""),
        name: device.name == null ? null : String(device.name),
        status: String(device.status ?? "UNKNOWN").toUpperCase(),
        enabled: device.enabled !== false,
        lastHeartbeatAt: device.lastHeartbeatAt == null ? null : String(device.lastHeartbeatAt),
      })).filter((device) => Boolean(device.deviceId))
    : [];
  return { ok: true, statusCode: response.status, devices };
}

function selectFleetDevice(devices: FleetGatewayDevice[], configuredDeviceId: string | null) {
  if (configuredDeviceId) {
    const selected = devices.find((device) => device.deviceId === configuredDeviceId);
    return {
      deviceId: configuredDeviceId,
      status: selected ? selected.enabled ? selected.status : "DISABLED" : "NOT_ASSIGNED",
      selection: "explicit" as const,
    };
  }

  const online = devices.filter((device) => device.enabled && device.status === "ONLINE");
  if (online.length === 1) {
    return { deviceId: online[0].deviceId, status: "ONLINE", selection: "single_online" as const };
  }

  const enabled = devices.filter((device) => device.enabled);
  if (enabled.length === 1) {
    return {
      deviceId: enabled[0].deviceId,
      status: enabled[0].status,
      selection: "single_assigned" as const,
    };
  }

  return {
    deviceId: null,
    status: online.length > 1 ? "AMBIGUOUS_ONLINE_DEVICES" : enabled.length > 1 ? "AMBIGUOUS_ASSIGNED_DEVICES" : "NO_ASSIGNED_DEVICE",
    selection: "unresolved" as const,
  };
}

export async function sendFleetWa(args: { phone: string; message: string; idempotencyKey?: string }) {
  const cfg = gatewayConfig();
  const baseUrl = required(cfg.baseUrl, "CST_WA_GATEWAY_URL");
  const token = required(cfg.token, "CST_WA_GATEWAY_TOKEN");
  const phone = normalizeFleetPhone(args.phone);
  if (!phone) throw new Error("Nomor WhatsApp Fleet tidak valid.");

  const registry = await listFleetGatewayDevices(baseUrl, token);
  if (!registry.ok) {
    if (registry.statusCode === 401 || registry.statusCode === 403) {
      throw new Error("Token WA Gateway Fleet tidak memiliki akses device.");
    }
    throw new Error(`WA Gateway device registry HTTP ${registry.statusCode}`);
  }

  const selection = selectFleetDevice(registry.devices, cfg.configuredDeviceId);
  if (!selection.deviceId) {
    throw new Error(`Device WA Fleet belum dapat ditentukan: ${selection.status}`);
  }
  if (selection.status !== "ONLINE") {
    throw new Error(`Device WA Fleet ${selection.deviceId} tidak ONLINE: ${selection.status}`);
  }

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
      deviceId: selection.deviceId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? payload.message ?? `WA Gateway HTTP ${response.status}`));
  return {
    messageId: String(payload.messageId ?? payload.id ?? payload.requestId ?? "") || null,
    senderDevice: selection.deviceId,
    deviceStatus: "ONLINE",
  };
}

export async function getFleetWaGatewayStatus() {
  const cfg = gatewayConfig();
  if (!cfg.baseUrl || !cfg.token) {
    return {
      configured: false,
      gatewayHealthy: false,
      gatewayStatus: !cfg.baseUrl ? "UNCONFIGURED_URL" : "UNCONFIGURED_TOKEN",
      deviceId: cfg.configuredDeviceId,
      deviceStatus: null,
      deviceSelection: "unresolved",
      visibleDevices: [] as FleetGatewayDevice[],
    };
  }

  let gatewayHealthy = false;
  let gatewayStatus = "UNKNOWN";
  try {
    const health = await fetch(`${cfg.baseUrl}/health`, { signal: AbortSignal.timeout(8_000) });
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

  let visibleDevices: FleetGatewayDevice[] = [];
  let deviceId: string | null = cfg.configuredDeviceId;
  let deviceStatus: string | null = null;
  let deviceSelection = "unresolved";

  try {
    const registry = await listFleetGatewayDevices(cfg.baseUrl, cfg.token);
    if (registry.ok) {
      visibleDevices = registry.devices;
      const selected = selectFleetDevice(visibleDevices, cfg.configuredDeviceId);
      deviceId = selected.deviceId;
      deviceStatus = selected.status;
      deviceSelection = selected.selection;
    } else if (registry.statusCode === 401 || registry.statusCode === 403) {
      deviceStatus = "TOKEN_FORBIDDEN";
    } else {
      deviceStatus = `HTTP_${registry.statusCode}`;
    }
  } catch {
    deviceStatus = "UNREACHABLE";
  }

  return {
    configured: Boolean(cfg.baseUrl && cfg.token && deviceId),
    gatewayHealthy,
    gatewayStatus,
    deviceId,
    deviceStatus,
    deviceSelection,
    visibleDevices,
  };
}
