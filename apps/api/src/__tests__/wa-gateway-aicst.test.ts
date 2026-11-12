import { afterEach, describe, expect, it, vi } from "vitest";
import { sendFleetWa } from "../lib/wa-gateway-client";

const saved = {
  url: process.env.CST_WA_GATEWAY_URL,
  token: process.env.CST_WA_GATEWAY_TOKEN,
  device: process.env.FLEET_WA_DEVICE_ID,
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of [
    ["CST_WA_GATEWAY_URL", saved.url],
    ["CST_WA_GATEWAY_TOKEN", saved.token],
    ["FLEET_WA_DEVICE_ID", saved.device],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Fleet DEV migration to aicst.co.id", () => {
  it("preserves device, bearer token, recipient and idempotency using mocked requests only", async () => {
    process.env.CST_WA_GATEWAY_URL = "https://aicst.co.id/";
    process.env.CST_WA_GATEWAY_TOKEN = "synthetic-token";
    process.env.FLEET_WA_DEVICE_ID = "fleet-device-test";
    const requests: {url: string; init: RequestInit | undefined}[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      requests.push({ url: input, init });
      if (input.endsWith("/v1/devices")) return new Response(JSON.stringify({
        devices: [{ deviceId: "fleet-device-test", name: "Fleet", status: "ONLINE", enabled: true, lastHeartbeatAt: null }],
      }), { status: 200 });
      return new Response(JSON.stringify({ messageId: "synthetic-message-id" }), { status: 202 });
    }));
    const result = await sendFleetWa({ phone: "081234567899", message: "synthetic only", idempotencyKey: "fleet-cutover-test" });
    expect(result.senderDevice).toBe("fleet-device-test");
    expect(requests.map((r) => r.url)).toEqual(["https://aicst.co.id/v1/devices", "https://aicst.co.id/v1/messages"]);
    expect(requests[1].init?.headers).toMatchObject({
      Authorization: "Bearer synthetic-token",
      "Idempotency-Key": "fleet-cutover-test",
    });
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      type: "text", to: "6281234567899", text: "synthetic only", deviceId: "fleet-device-test",
    });
  });
});
