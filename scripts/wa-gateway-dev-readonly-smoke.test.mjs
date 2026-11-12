import test from "node:test";
import assert from "node:assert/strict";
import { checkFleetDevGateway } from "./wa-gateway-dev-readonly-smoke.mjs";

const base = {
  APP_ENV: "development",
  CST_WA_GATEWAY_URL: "https://aicst.co.id",
  CST_WA_GATEWAY_TOKEN: "synthetic-only",
  FLEET_WA_DEVICE_ID: "test-fleet",
};

test("refuses production and never calls fetch", async () => {
  let called = false;
  const result = await checkFleetDevGateway({ ...base, APP_ENV: "production" }, async () => {
    called = true;
  });
  assert.deepEqual(result, { pass: false, reason: "DEV_ONLY" });
  assert.equal(called, false);
});

test("refuses missing token and incorrect domain", async () => {
  assert.equal((await checkFleetDevGateway({ ...base, CST_WA_GATEWAY_TOKEN: "" })).reason, "DEV_TOKEN_MISSING");
  assert.equal((await checkFleetDevGateway({ ...base, CST_WA_GATEWAY_URL: "https://wa.cstlogistic.co.id" })).reason, "EXPECTED_NEW_DOMAIN");
});

test("GET only, token stays out of result, device must be online", async () => {
  const result = await checkFleetDevGateway(base, async (url, init) => {
    assert.equal(url, "https://aicst.co.id/v1/devices");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer synthetic-only");
    return new Response(JSON.stringify({
      devices: [{ deviceId: "test-fleet", enabled: true, status: "ONLINE" }],
    }), { status: 200 });
  });
  assert.deepEqual(result, { pass: true, reason: "DEV_AUTH_AND_DEVICE_ONLINE" });
  assert.equal(JSON.stringify(result).includes("synthetic-only"), false);
});

test("rejects unauthorized response safely", async () => {
  const result = await checkFleetDevGateway(base, async () => new Response("", { status: 401 }));
  assert.deepEqual(result, { pass: false, reason: "GATEWAY_HTTP_401" });
});
