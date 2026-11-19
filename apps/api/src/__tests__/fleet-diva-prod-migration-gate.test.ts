import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";
const sql=readFileSync(resolve(process.cwd(),"../../deploy/prod-diva-asset-release-20261118.sql"),"utf8");
const doc=readFileSync(resolve(process.cwd(),"../../deploy/DIVA_PROD_RELEASE_GATE.md"),"utf8");

describe("Diva production migration: no Gojek operations touched",()=>{
 it("creates exactly the three owner-confirmed Company 3 Wuling EV asset references",()=>{
  for(const plate of ["B1649PNV","B1650PNV","B1926PDT"])expect(sql).toContain(plate);
  expect(sql).toContain("'3',d.unit_number,d.plate_number,'car','Wuling','Cloud EV'");
  expect(sql).toContain("SELECT pg_advisory_xact_lock");
  expect(sql).toContain("RLS");
 });
 it("uses the 2027 renewed tax proof and unrenewed December tax correctly",()=>{
  for(const plate of ["B1649PNV","B1650PNV"]){
   expect(sql).toContain(`('${plate}',DATE '2026-11-17',DATE '2027-11-11','paid_due_verified'`);
  }
  expect(sql).toContain("('B1926PDT',NULL::date,DATE '2026-12-30','due_soon'");
 });
 it("grants narrow scoped roles with passwords NULL until separately activated",()=>{
  expect(sql).toContain("fleet_diva_asset_reader_login_prod");
  expect(sql).toContain("fleet_diva_tax_editor_login_prod");
  expect(sql).toContain("LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER NOBYPASSRLS");
  expect(sql).toContain("GRANT UPDATE (issued_date,expired_date,status,notes,updated_at)");
  expect(sql).toContain("ALTER TABLE public.fleet_tax_edit_audit ENABLE ROW LEVEL SECURITY");
 });
 it("contains no destructive mutation on Gojek source tables",()=>{
  expect(sql).not.toMatch(/\b(?:TRUNCATE|DROP|DELETE)\b/i);
  expect(sql).not.toMatch(/\b(?:UPDATE|INSERT\s+INTO|ALTER\s+TABLE)\s+public\.fleet_(?:drivers|vehicles|transactions|outstanding|gojek_sync_jobs)\b/i);
 });
 it("release documentation makes PROD activation conditional",()=>{
  expect(doc).toContain("not a production code deployment");
  expect(doc).toContain("production");
  expect(doc).toContain("Hostinger");
 });
});
