import { afterEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(()=>({connect:vi.fn(),query:vi.fn(),release:vi.fn()}));
vi.mock("../lib/fleet-diva-tax-db",()=>({divaTaxWriterPool:{connect:fake.connect}}));
import { DivaTaxEditError, editDivaAnnualTax } from "../lib/fleet-diva-tax-edit";
const version = "2026-11-18T13:00:00+00:00";
const before = {id:3,paid_on:"2026-11-17",due_on:null,status:"paid_late_due_unverified",version};
const after = {id:3,paid_on:"2026-11-17",due_on:"2027-11-11",status:"paid_due_verified",version:"2026-11-18T13:00:01+00:00"};
const payload = {paidOn:"2026-11-17",dueOn:"2027-11-11",status:"paid_due_verified",version,note:"STNK baru diterima"};
function setup(failAudit=false){
  fake.query.mockImplementation(async(sql:string)=>{
    if(sql.includes("SELECT d.id"))return {rows:[before]};
    if(sql.includes("UPDATE public.fleet_documents"))return {rows:[after]};
    if(sql.includes("INSERT INTO public.fleet_tax_edit_audit_dev")) {
      if(failAudit)throw new Error("QA simulated audit write failure");
      return {rowCount:1,rows:[]};
    }
    return {rows:[],rowCount:0};
  });
  fake.connect.mockResolvedValue({query:fake.query,release:fake.release});
}
afterEach(()=>vi.resetAllMocks());
describe("Diva tax editor transaction and audit",()=>{
  it("writes only one document update plus append-only audit in one transaction",async()=>{
    setup();
    const x=await editDivaAnnualTax("B1649PNV",payload,"owner@example.test");
    expect(x).toMatchObject({ok:true,companyId:3,plate:"B1649PNV",dueOn:"2027-11-11"});
    const commands=fake.query.mock.calls.map(([sql]:[string])=>sql);
    expect(commands).toContain("BEGIN");
    expect(commands).toContain("COMMIT");
    expect(commands.some((s:string)=>s.includes("INSERT INTO public.fleet_tax_edit_audit_dev"))).toBe(true);
    const update=commands.find((s:string)=>s.includes("UPDATE public.fleet_documents"))??"";
    expect(update).toContain("updated_at=$6::timestamptz");
    expect(update).toContain("company_id='3'");
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it("rolls back document update if audit cannot be inserted",async()=>{
    setup(true);
    await expect(editDivaAnnualTax("B1649PNV",payload,"owner@example.test")).rejects.toThrow("audit");
    const commands=fake.query.mock.calls.map(([sql]:[string])=>sql);
    expect(commands).toContain("ROLLBACK");
    expect(commands).not.toContain("COMMIT");
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it("rejects stale version and never writes or commits",async()=>{
    setup();
    const error=await editDivaAnnualTax("B1649PNV",{...payload,version:"2026-11-18T12:00:00Z"},"owner@example.test").then(()=>null,e=>e);
    expect(error).toBeInstanceOf(DivaTaxEditError);
    expect(error.status).toBe(409);
    const commands=fake.query.mock.calls.map(([sql]:[string])=>sql);
    expect(commands.some((s:string)=>s.includes("UPDATE public.fleet_documents"))).toBe(false);
    expect(commands).toContain("ROLLBACK");
  });
});
