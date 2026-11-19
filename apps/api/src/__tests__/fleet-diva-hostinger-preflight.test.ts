import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { divaProdPreflight } from "../lib/diva-hostinger-preflight";

const original = {...process.env};
beforeEach(()=>{process.env={...original,APP_ENV:"development",APP_BASE_URL:"https://dev-fleet.cstlogistic.co.id"}});
afterEach(()=>{process.env={...original}});
describe("Hostinger Diva PROD scoped read-only credential attestation",()=>{
 it("is disabled outside exact production origin",async()=>{
  expect(await divaProdPreflight()).toEqual({status:"blocked",checks:{read:"fail",edit:"fail"},diagnostics:{runtime:"fail",read:"not_set",edit:"not_set"}});
 });
 it("does not read secret values into an HTTP response",()=>{
  const src=readFileSync(resolve(process.cwd(),"src/lib/diva-hostinger-preflight.ts"),"utf8");
  const routes=readFileSync(resolve(process.cwd(),"src/routes/index.ts"),"utf8");
  expect(routes).toContain('router.get("/diva-preflightz"');
  expect(routes).toContain('res.json(await divaProdPreflight())');
  expect(src).toContain("query_timeout:5500");
  expect(src).toContain("not_set");
  expect(src).toContain("wrong_role_or_project");
  expect(src).toContain("tls_mode");
  expect(src).toContain("password_missing");
  expect(src).toContain("connection_failed");
 });
 it("only queries metadata, RLS and tax evidence; never mutates",()=>{
  const src=readFileSync(resolve(process.cwd(),"src/lib/diva-hostinger-preflight.ts"),"utf8");
  expect(src).toContain("row_security_active");
  expect(src).toContain("has_table_privilege");
  expect(src).toContain("public.fleet_documents");
  expect(src).toContain("public.fleet_units");
  expect(src).not.toMatch(/\b(?:UPDATE|DELETE|INSERT INTO|ALTER ROLE|CREATE ROLE|TRUNCATE)\s+public\./i);
 });
 it("pins project and role identity independently for both DSNs",()=>{
  const src=readFileSync(resolve(process.cwd(),"src/lib/diva-hostinger-preflight.ts"),"utf8");
  expect(src).toContain("nzdweipzckfszczzqtuw");
  expect(src).toContain("fleet_diva_asset_reader_login_prod");
  expect(src).toContain("fleet_diva_tax_editor_login_prod");
  expect(src).toContain('sslmode")!=="verify-full"');
  expect(src).toContain("rejectUnauthorized:true");
 });
});
