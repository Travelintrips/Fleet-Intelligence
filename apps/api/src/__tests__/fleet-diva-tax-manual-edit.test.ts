import { describe, expect, it } from "vitest";
import { validateDivaTaxEdit } from "../lib/fleet-diva-tax-edit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const good = {paidOn:"2026-11-17",dueOn:null,status:"paid_late_due_unverified",version:"2026-11-18T12:00:00Z",note:"Sudah dibayar"};
describe("Manual DEV Diva annual tax editing", () => {
  it("accepts known plate and valid historic late payment without inventing next due",()=>{
    expect(validateDivaTaxEdit("B1649PNV",good)).toMatchObject({paidOn:"2026-11-17",dueOn:null,status:"paid_late_due_unverified"});
  });
  it("accepts a verified future expiry",()=>{
    expect(validateDivaTaxEdit("B1650PNV",{...good,dueOn:"2027-11-11",status:"paid_due_verified"}).dueOn).toBe("2027-11-11");
  });
  it("allows known unpaid unit with due date",()=>{
    expect(validateDivaTaxEdit("B1926PDT",{...good,paidOn:null,dueOn:"2026-12-30",status:"due_soon"}).dueOn).toBe("2026-12-30");
  });
  it.each(["B1234XYZ","B 1649 PNV","B1650PNVXYZ"])("rejects noncanonical/unapproved plate %s",(plate)=>{
    expect(()=>validateDivaTaxEdit(plate,good)).toThrow();
  });
  it.each(["2026-02-30","2026-13-01","2026-00-01","2026-11-31","tomorrow"])("rejects invalid calendar date %s",(date)=>{
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,paidOn:date})).toThrow();
  });
  it("refuses status paid without paid date",()=>{
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,paidOn:null})).toThrow();
  });
  it("refuses verified next year without due date",()=>{
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,status:"paid_due_verified",dueOn:null})).toThrow();
  });
  it("refuses backdating the next due earlier than payment",()=>{
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,status:"paid_due_verified",dueOn:"2026-11-11"})).toThrow();
  });
  it("refuses unknown status and missing version",()=>{
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,status:"owned"})).toThrow();
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,version:null})).toThrow();
  });
  it("refuses multiline or oversized notes",()=>{
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,note:"bad\ninput"})).toThrow();
    expect(()=>validateDivaTaxEdit("B1649PNV",{...good,note:"x".repeat(301)})).toThrow();
  });
  it("keeps the application writer separate and strictly DEV-only",()=>{
    const api=readFileSync(resolve(process.cwd(),"src/routes/fleet-intelligence.ts"),"utf8");
    const section=api.split('router.patch("/vehicles/diva-assets/:plate/tax"')[1]?.split('router.get("/vehicles"')[0];
    expect(section).toContain('req.get("origin")');
    expect(section).toContain('divaTaxWriterEnabled()');
    expect(section).toContain('req.adminUser?.companyId');
    expect(section).toContain('editDivaAnnualTax(');
    expect(section).not.toContain("fleetCashPool.query");
  });
  it("keeps regex proxy limited to the 3 plates and only PATCH",()=>{
    const nginx=readFileSync(resolve(process.cwd(),"../../deploy/dev-only/nginx-staging-readonly.conf"),"utf8");
    expect(nginx).toContain("(B1649PNV|B1650PNV|B1926PDT)/tax$");
    expect(nginx).toContain("limit_except PATCH { deny all; }");
    expect(nginx).toContain("location / { return 404; }");
  });
  it("role migration protects existing stage reader and audit",()=>{
    const sql=readFileSync(resolve(process.cwd(),"../../deploy/dev-only/diva-tax-manual-editor-20261118.sql"),"utf8");
    expect(sql).toContain("fleet_diva_tax_editor_login_dev");
    expect(sql).toContain("PASSWORD NULL");
    expect(sql).toContain("NOINHERIT NOSUPERUSER NOBYPASSRLS");
    expect(sql).toContain("AS RESTRICTIVE FOR UPDATE");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.fleet_tax_edit_audit_dev");
    expect(sql).not.toContain("GRANT UPDATE (file_url");
  });
});
