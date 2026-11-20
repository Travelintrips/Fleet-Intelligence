import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const router = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");
const divaSection = router.slice(router.indexOf('router.get("/vehicles/diva-assets"'),router.indexOf('router.patch("/vehicles/diva-assets/:plate/tax"'));

describe("Company 3 VIN and engine number read-only registry contract",()=>{
  it("reads chassis and engine IDs only through the dedicated Diva scoped reader",()=>{
    expect(divaSection).toContain("!canManageDivaTax(req.adminUser)");
    expect(divaSection).toContain("divaAssetReadPool.query(");
    expect(divaSection).toContain("u.chassis_number,u.engine_number");
    expect(divaSection).toContain("WHERE u.company_id=$1");
    expect(divaSection).toContain('["3"]');
    expect(divaSection).toContain('Cache-Control", "private, no-store');
  });
  it("never writes source Fleet or Gojek vehicles in asset reader",()=>{
    expect(divaSection).not.toMatch(/INSERT INTO|UPDATE public|DELETE FROM public/);
    expect(divaSection).not.toContain("public.fleet_vehicles");
    expect(divaSection).not.toContain("public.fleet_transactions");
  });
});
