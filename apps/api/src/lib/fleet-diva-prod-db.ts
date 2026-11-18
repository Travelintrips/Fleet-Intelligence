import pg from "pg";
import { X509Certificate } from "node:crypto";
import { SUPABASE_FINANCE_ROOT_2021_PEM, SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256 } from "./supabase-finance-root-2021";

const PROJECT="nzdweipzckfszczzqtuw";
const ORIGIN="https://fleet.cstlogistic.co.id";
const ROLES={read:"fleet_diva_asset_reader_login_prod",edit:"fleet_diva_tax_editor_login_prod"} as const;
let reader:pg.Pool|null=null,editor:pg.Pool|null=null;

export const divaAssetReadEnabled=()=>process.env.APP_ENV==="production" &&
 process.env.APP_BASE_URL===ORIGIN && process.env.FLEET_DIVA_ASSET_READ_ENABLED_PROD==="true";
export const divaTaxWriterEnabled=()=>divaAssetReadEnabled() && process.env.FLEET_DIVA_TAX_EDIT_ENABLED_PROD==="true";

export function divaProdOptions(raw:string,kind:"read"|"edit"):pg.PoolConfig {
 if(!(kind==="read"?divaAssetReadEnabled():divaTaxWriterEnabled()))throw Error("DIVA_PROD_DISABLED");
 let u:URL;try{u=new URL(raw)}catch{throw Error("DIVA_PROD_INVALID_DSN")}
 const direct=u.hostname===`db.${PROJECT}.supabase.co`;
 const pooler=u.hostname.endsWith(".pooler.supabase.com");
 const role=ROLES[kind],user=decodeURIComponent(u.username);
 const port=Number(u.port||5432);
 if(!["postgres:","postgresql:"].includes(u.protocol)||(!direct&&!pooler)||
  (direct?user!==role:user!==role+"."+PROJECT)||!u.password||
  u.pathname!=="/postgres"||![5432,6543].includes(port)||
  (direct&&port!==5432)||u.searchParams.get("sslmode")!=="verify-full")
   throw Error("DIVA_PROD_WRONG_PROJECT_OR_ROLE");
 const cert=new X509Certificate(SUPABASE_FINANCE_ROOT_2021_PEM);
 if(!cert.ca||cert.fingerprint256!==SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256)
   throw Error("DIVA_PROD_TLS_ANCHOR_INVALID");
 return {host:u.hostname,port,user,password:decodeURIComponent(u.password),database:"postgres",
  ssl:{ca:SUPABASE_FINANCE_ROOT_2021_PEM,servername:u.hostname,rejectUnauthorized:true},
  max:2,connectionTimeoutMillis:8000,idleTimeoutMillis:5000,query_timeout:15000,
  application_name:`fleet-diva-${kind}-prod`};
}
async function getPool(kind:"read"|"edit"):Promise<pg.Pool>{
 const allowed=kind==="read"?divaAssetReadEnabled():divaTaxWriterEnabled();
 if(!allowed)throw Error("DIVA_PROD_FEATURE_DISABLED");
 const value=process.env[kind==="read"?"FLEET_DIVA_ASSET_DATABASE_URL_PROD":"FLEET_DIVA_TAX_DATABASE_URL_PROD"];
 if(!value)throw Error("DIVA_PROD_DB_UNCONFIGURED");
 const existing=kind==="read"?reader:editor;
 if(existing)return existing;
 const p=new pg.Pool(divaProdOptions(value,kind));
 try{
  const q=await p.query("SELECT current_user::text role,session_user::text login_role,rolsuper,rolbypassrls,row_security_active('public.fleet_units'::regclass) unit_rls,row_security_active('public.fleet_documents'::regclass) docs_rls FROM pg_roles WHERE rolname=current_user");
  const x=q.rows[0],role=ROLES[kind];
  if(x?.role!==role||x?.login_role!==role||x?.rolsuper!==false||x?.rolbypassrls!==false||
     x?.unit_rls!==true||x?.docs_rls!==true)throw Error("DIVA_PROD_ROLE_RLS_INVALID");
  if(kind==="edit"){
   const y=(await p.query("SELECT row_security_active('public.fleet_tax_edit_audit'::regclass) audit_rls,has_column_privilege(current_user,'public.fleet_documents','expired_date','UPDATE') can_edit_due,has_column_privilege(current_user,'public.fleet_documents','file_url','UPDATE') can_edit_file,has_table_privilege(current_user,'public.fleet_transactions','UPDATE') can_edit_tx FROM pg_roles WHERE rolname=current_user")).rows[0];
   if(y?.audit_rls!==true||y?.can_edit_due!==true||y?.can_edit_file!==false||y?.can_edit_tx!==false)
     throw Error("DIVA_PROD_EDITOR_SCOPE_INVALID");
  }
  if(kind==="read")reader=p;else editor=p;
  return p;
 }catch(e){await p.end().catch(()=>{});throw e}
}
export const divaAssetReadPool={
 query:async (...args:unknown[]) => (await getPool("read")).query(...args as [string,unknown[]]),
};
export const divaTaxWriterPool={
 connect:async()=> (await getPool("edit")).connect(),
};
