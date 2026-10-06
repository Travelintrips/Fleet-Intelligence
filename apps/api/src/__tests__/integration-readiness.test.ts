import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routes = readFileSync(resolve(process.cwd(), "src/routes/index.ts"), "utf8");

describe("Fleet integration readiness", () => {
  it("exposes only sanitized WA and Central Finance readiness", () => {
    expect(routes).toContain('router.get("/integrationz"');
    expect(routes).toContain("deviceOnline");
    expect(routes).toContain("assignedDeviceCount");
    expect(routes).toContain("tokenConfigured");
    expect(routes).toContain("writeEnabled");
    expect(routes).not.toContain("CENTRAL_FINANCE_SERVICE_TOKEN: process.env");
    expect(routes).not.toContain("CST_WA_GATEWAY_TOKEN: process.env");
  });
});
