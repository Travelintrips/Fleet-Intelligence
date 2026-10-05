import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fleetRoute = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");

describe("Fleet destructive action safety", () => {
  it("requires explicit confirmation for report purge", () => {
    expect(fleetRoute).toContain("requireDestructiveConfirmation(req,`PURGE REPORT ${id}`)");
  });

  it("requires explicit confirmation for report deletion", () => {
    expect(fleetRoute).toContain("requireDestructiveConfirmation(req,`DELETE REPORT ${id}`)");
  });

  it("restricts purge-all to owner/super_admin and company-scoped confirmation", () => {
    expect(fleetRoute).toContain("PURGE ALL FLEET DATA COMPANY");
    expect(fleetRoute).toContain("{ownerOnly:true}");
    expect(fleetRoute).toContain('role !== "owner" && role !== "super_admin"');
  });

  it("accepts confirmation only from an explicit header or body field", () => {
    expect(fleetRoute).toContain('req.get("x-fleet-confirmation")');
    expect(fleetRoute).toContain("req.body?.confirmation");
  });
});
