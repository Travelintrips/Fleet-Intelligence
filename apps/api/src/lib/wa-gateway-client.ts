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

type FleetDeviceSelection = {
  deviceId: string | null;
  status: string;
  selection: "explicit" | "single_online" | "single_assigned" | "unresolved";
};

type CachedDeviceSelection = {
  expiresAt: number;
  key: string;
  selection: FleetDeviceSelection;
  devices: FleetGatewayDevice[];
};

let deviceSelectionCache: CachedDeviceSelection | null = null;
const DEVICE_CACHE_MS = 30_000;

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
    signal: AbortSignal.timeout(5_000),
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

function selectFleetDevice(devices: FleetGatewayDevice[], configuredDeviceId: string | null): FleetDeviceSelection {
  if (configuredDeviceId) {
    const selected = devices.find((device) => device.deviceId === configuredDeviceId);
    return {
      deviceId: configuredDeviceId,
      status: selected ? selected.enabled ? selected.status : "DISABLED" : "NOT_ASSIGNED",
      selection: "explicit",
    };
  }

  const online = devices.filter((device) => device.enabled && device.status === "ONLINE");
  if (online.length === 1) {
    return { deviceId: online[0].deviceId, status: "ONLINE", selection: "single_online" };
  }

  const enabled = devices.filter((device) => device.enabled);
  if (enabled.length === 1) {
    return {
      deviceId: enabled[0].deviceId,
      status: enabled[0].status,
      selection: "single_assigned",
    };
  }

  return {
    deviceId: null,
    status: online.length > 1 ? "AMBIGUOUS_ONLINE_DEVICES" : enabled.length > 1 ? "AMBIGUOUS_ASSIGNED_DEVICES" : "NO_ASSIGNED_DEVICE",
    selection: "unresolved",
  };
}

async function resolveFleetDevice(baseUrl: string, token: string, configuredDeviceId: string | null, force = false) {
  const key = `${baseUrl}|${configuredDeviceId ?? ""}|${token.slice(0, 12)}`;
  if (!force && deviceSelectionCache && deviceSelectionCache.key === key && deviceSelectionCache.expiresAt > Date.now()) {
    return {
      ok: true,
      statusCode: 200,
      devices: deviceSelectionCache.devices,
      selection: deviceSelectionCache.selection,
      cached: true,
    };
  }

  const registry = await listFleetGatewayDevices(baseUrl, token);
  if (!registry.ok) {
    return { ...registry, selection: null, cached: false };
  }
  const selection = selectFleetDevice(registry.devices, configuredDeviceId);
  deviceSelectionCache = {
    key,
    expiresAt: Date.now() + DEVICE_CACHE_MS,
    selection,
    devices: registry.devices,
  };
  return { ...registry, selection, cached: false };
}

export async function sendFleetWa(args: { phone: string; message: string; idempotencyKey?: string }) {
  const cfg = gatewayConfig();
  const baseUrl = required(cfg.baseUrl, "CST_WA_GATEWAY_URL");
  const token = required(cfg.token, "CST_WA_GATEWAY_TOKEN");
  const phone = normalizeFleetPhone(args.phone);
  if (!phone) throw new Error("Nomor WhatsApp Fleet tidak valid.");

  let lastError = "WA Gateway gagal mengirim pesan.";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveFleetDevice(baseUrl, token, cfg.configuredDeviceId, attempt > 0);
    if (!resolved.ok || !resolved.selection) {
      if (resolved.statusCode === 401 || resolved.statusCode === 403) {
        throw new Error("Token WA Gateway Fleet tidak memiliki akses device.");
      }
      throw new Error(`WA Gateway device registry HTTP ${resolved.statusCode}`);
    }

    const selection = resolved.selection;
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
    if (response.ok) {
      return {
        messageId: String(payload.messageId ?? payload.id ?? payload.requestId ?? "") || null,
        senderDevice: selection.deviceId,
        deviceStatus: "ONLINE",
      };
    }

    lastError = String(payload.error ?? payload.message ?? `WA Gateway HTTP ${response.status}`);
    const staleDevice =
      response.status === 409 ||
      response.status === 422 ||
      response.status === 503 ||
      /disconnected device|device.*disconnect|not connected|offline/i.test(lastError);

    if (!staleDevice || attempt > 0) {
      throw new Error(lastError);
    }

    deviceSelectionCache = null;
  }

  throw new Error(lastError);
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

  const healthPromise = fetch(`${cfg.baseUrl}/health`, {
    signal: AbortSignal.timeout(5_000),
  }).then(async (response) => {
    if (!response.ok) return { healthy: false, status: `HTTP_${response.status}` };
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const healthy = String(payload?.status ?? "").toLowerCase() === "ok";
    return { healthy, status: healthy ? "OK" : String(payload?.status ?? "UNKNOWN").toUpperCase() };
  }).catch(() => ({ healthy: false, status: "UNREACHABLE" }));

  const registryPromise = resolveFleetDevice(
    cfg.baseUrl,
    cfg.token,
    cfg.configuredDeviceId,
    true,
  ).catch(() => null);

  const [health, registry] = await Promise.all([healthPromise, registryPromise]);

  let visibleDevices: FleetGatewayDevice[] = [];
  let deviceId: string | null = cfg.configuredDeviceId;
  let deviceStatus: string | null = null;
  let deviceSelection = "unresolved";

  if (registry?.ok && registry.selection) {
    visibleDevices = registry.devices;
    deviceId = registry.selection.deviceId;
    deviceStatus = registry.selection.status;
    deviceSelection = registry.selection.selection;
  } else if (registry) {
    deviceStatus = registry.statusCode === 401 || registry.statusCode === 403
      ? "TOKEN_FORBIDDEN"
      : `HTTP_${registry.statusCode}`;
  } else {
    deviceStatus = "UNREACHABLE";
  }

  return {
    configured: Boolean(cfg.baseUrl && cfg.token && deviceId),
    gatewayHealthy: health.healthy,
    gatewayStatus: health.status,
    deviceId,
    deviceStatus,
    deviceSelection,
    visibleDevices,
  };
}
