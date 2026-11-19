import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {divaAssetReadEnabled,divaTaxWriterEnabled,divaProdOptions} from "../lib/fleet-diva-prod-db";
const env={...process.env};
beforeEach(()=>{Object.assign(process.env,{APP_ENV:"production",APP_BASE_URL:"https://fleet.cstlogistic.co.id",FLEET_DIVA_ASSET_READ_ENABLED_PROD:"false",FLEET_DIVA_TAX_EDIT_ENABLED_PROD:"false"})});
afterEach(()=>{process.env={...env}});
describe("Diva PROD release isolation",()=>{
 it("defaults both production read and write OFF",()=>{
  expect(divaAssetReadEnabled()).toBe(false);
  expect(divaTaxWriterEnabled()).toBe(false);
  expect(()=>divaProdOptions("postgresql://fake","read")).toThrow("DISABLED");
 });
 it("enables read only under exact PROD origin and explicit flag",()=>{
  process.env.FLEET_DIVA_ASSET_READ_ENABLED_PROD="true";
  expect(divaAssetReadEnabled()).toBe(true);
  expect(divaTaxWriterEnabled()).toBe(false);
  process.env.APP_BASE_URL="https://dev-fleet.cstlogistic.co.id";
  expect(divaAssetReadEnabled()).toBe(false);
 });
 it("requires separate write flag even if read enabled",()=>{
  process.env.FLEET_DIVA_ASSET_READ_ENABLED_PROD="true";
  expect(divaTaxWriterEnabled()).toBe(false);
  process.env.FLEET_DIVA_TAX_EDIT_ENABLED_PROD="true";
  expect(divaTaxWriterEnabled()).toBe(true);
 });
 it("requires PROD project, precise role and TLS hostname",()=>{
  process.env.FLEET_DIVA_ASSET_READ_ENABLED_PROD="true";
  const good="postgresql://fleet_diva_asset_reader_login_prod.nzdweipzckfszczzqtuw:synthetic@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";
  const x=divaProdOptions(good,"read");
  expect(x).toMatchObject({user:"fleet_diva_asset_reader_login_prod.nzdweipzckfszczzqtuw",max:2,ssl:{rejectUnauthorized:true}});
  expect(()=>divaProdOptions(good.replace("nzdweipzckfszczzqtuw","xssrfshdrtdfupgqwfdw"),"read")).toThrow();
  expect(()=>divaProdOptions(good.replace("reader_login_prod","tax_editor_login_prod"),"read")).toThrow();
  expect(()=>divaProdOptions(good.replace("verify-full","disable"),"read")).toThrow();
 });
 it("does not permit DEV flag or any production write to Fleet tax while disabled",()=>{
  process.env.FLEET_DIVA_TAX_EDIT_ENABLED_PROD="true";
  expect(divaTaxWriterEnabled()).toBe(false);
  process.env.APP_ENV="development";process.env.FLEET_DIVA_ASSET_READ_ENABLED_PROD="true";
  expect(divaAssetReadEnabled()).toBe(false);
 });
});
