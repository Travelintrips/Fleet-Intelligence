import { pathToFileURL } from "node:url";

export async function checkFleetDevGateway(env = process.env, fetcher = fetch) {
  if (env.APP_ENV !== "development") {
    return { pass: false, reason: "DEV_ONLY" };
  }
  const url = String(env.CST_WA_GATEWAY_URL ?? env.WA_GATEWAY_URL ?? "").trim().replace(/\/+$/, "");
  if (url !== "https://aicst.co.id") {
    return { pass: false, reason: "EXPECTED_NEW_DOMAIN" };
  }
  const token = String(env.CST_WA_GATEWAY_TOKEN ?? env.WA_GATEWAY_TOKEN ?? "").trim();
  if (!token) {
    return { pass: false, reason: "DEV_TOKEN_MISSING" };
  }
  const deviceId = String(env.FLEET_WA_DEVICE_ID ?? "").trim();
  if (!deviceId) {
    return { pass: false, reason: "DEV_DEVICE_ID_MISSING" };
  }

  try {
    // Read-only device listing. Never POST messages, mutate a device or display credentials.
    const response = await fetcher(url + "/v1/devices", {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { pass: false, reason: "GATEWAY_HTTP_" + response.status };
    const payload = await response.json();
    if (!Array.isArray(payload?.devices)) return { pass: false, reason: "INVALID_DEVICE_LIST" };
    const match = payload.devices.find((d) => d?.deviceId === deviceId);
    if (!match) return { pass: false, reason: "DEVICE_NOT_ASSIGNED" };
    if (match.enabled !== true || String(match.status).toUpperCase() !== "ONLINE") {
      return { pass: false, reason: "DEVICE_NOT_ONLINE" };
    }
    return { pass: true, reason: "DEV_AUTH_AND_DEVICE_ONLINE" };
  } catch {
    return { pass: false, reason: "DEV_GATEWAY_REQUEST_FAILED" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkFleetDevGateway();
  console.log(JSON.stringify(result));
  process.exitCode = result.pass ? 0 : 1;
}
