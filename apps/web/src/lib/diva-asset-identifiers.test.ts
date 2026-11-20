import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/vehicles.tsx"),"utf8");

describe("Diva asset document IDs visible in existing table",()=>{
  it("exposes chassis and engine identifiers with safe empty labels",()=>{
    expect(page).toContain("chassis_number: string | null; engine_number: string | null;");
    expect(page).toContain("Nomor rangka / VIN");
    expect(page).toContain("Nomor mesin");
    expect(page).toContain('{asset.chassis_number || "Belum tercatat"}');
    expect(page).toContain('{asset.engine_number || "Belum tercatat"}');
  });
  it("continues to fetch assets using authenticated scoped endpoint",()=>{
    expect(page).toContain('fetch("/api/logistics/fleet/vehicles/diva-assets", { credentials: "include" })');
    expect(page).toContain('queryKey: ["fleet-diva-assets"]');
  });
});
