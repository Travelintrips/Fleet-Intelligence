import pg from "pg";
import { X509Certificate } from "node:crypto";
import { SUPABASE_FINANCE_ROOT_2021_PEM, SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256 } from "./supabase-finance-root-2021";

const PROJECT="nzdweipzckfszczzqtuw";
const ORIGIN="https://fleet.cstlogistic.co.id";
const ROLES={read:"fleet_diva_asset_reader_login_prod",edit:"fleet_diva_tax_editor_login_prod"} as const;
type Status="pass"|"fail";
type Stage="pass"|"not_set"|"url_syntax"|"wrong_scheme"|"wrong_host"|"wrong_role_or_project"|"password_missing"|"wrong_database"|"wrong_port"|"tls_mode"|"ca_invalid"|"connection_failed"|"role_or_rls_failed"|"permissions_failed"|"evidence_failed";
type Outcome={
 status:"ready"|"blocked";
 checks:{read:Status;edit:Status};
 diagnostics:{runtime:"pass"|"fail";read:Stage;edit:Stage};
};
let cache:{at:number;promise:Promise<Outcome>}|null=null;

function options(source:string,role:typeof ROLES[keyof typeof ROLES]):pg.PoolConfig {
  let uri:URL;
  try {uri=new URL(source)} catch {throw new Error("url_syntax")}
  const host=uri.hostname.toLowerCase(),port=Number(uri.port||5432),user=decodeURIComponent(uri.username);
  const pooler=/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  const direct=host===`db.${PROJECT}.supabase.co`;
  if(!["postgres:","postgresql:"].includes(uri.protocol))throw new Error("wrong_scheme");
  if(!pooler&&!direct)throw new Error("wrong_host");
  if(direct?user!==role:user!==role+"."+PROJECT)throw new Error("wrong_role_or_project");
  if(!uri.password)throw new Error("password_missing");
  if(uri.pathname!=="/postgres")throw new Error("wrong_database");
  if(![5432,6543].includes(port)||(direct&&port!==5432))throw new Error("wrong_port");
  if(uri.searchParams.get("sslmode")!=="verify-full")throw new Error("tls_mode");
  const cert=new X509Certificate(SUPABASE_FINANCE_ROOT_2021_PEM);
  if(!cert.ca||cert.fingerprint256!==SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256)
    throw new Error("ca_invalid");
  return {host,port,user,password:decodeURIComponent(uri.password),database:"postgres",
    ssl:{ca:SUPABASE_FINANCE_ROOT_2021_PEM,servername:host,rejectUnauthorized:true},
    max:1,connectionTimeoutMillis:5500,idleTimeoutMillis:1000,query_timeout:5500,
    application_name:"fleet-diva-prod-readonly-preflight"};
}

async function check(source:string|undefined,role:typeof ROLES[keyof typeof ROLES],writer:boolean):Promise<Stage> {
  if(!source?.trim())return "not_set";
  let config:pg.PoolConfig;
  try{config=options(source,role)}catch(error){
    const reason=error instanceof Error?error.message:"url_syntax";
    const known:Stage[]=["url_syntax","wrong_scheme","wrong_host","wrong_role_or_project","password_missing","wrong_database","wrong_port","tls_mode","ca_invalid"];
    return known.includes(reason as Stage)?reason as Stage:"url_syntax";
  }
  const pool=new pg.Pool(config);
  try{
    let identity;
    try{
      identity=(await pool.query(
        "SELECT current_user::text AS role,session_user::text AS login,rolsuper,rolbypassrls,"+
        "row_security_active('public.fleet_units'::regclass) AS units_rls,"+
        "row_security_active('public.fleet_documents'::regclass) AS docs_rls "+
        "FROM pg_roles WHERE rolname=current_user"
      )).rows[0];
    }catch{return "connection_failed"}
    if(identity?.role!==role||identity?.login!==role||identity?.rolsuper!==false||
       identity?.rolbypassrls!==false||identity?.units_rls!==true||identity?.docs_rls!==true)
      return "role_or_rls_failed";
    let grants;
    try{
      grants=(await pool.query(
        "SELECT has_table_privilege(current_user,'public.fleet_transactions','UPDATE') AS tx_write,"+
        "has_table_privilege(current_user,'public.fleet_vehicles','UPDATE') AS vehicle_write,"+
        "has_column_privilege(current_user,'public.fleet_documents','file_url','UPDATE') AS file_write,"+
        "has_column_privilege(current_user,'public.fleet_documents','expired_date','UPDATE') AS tax_write"
      )).rows[0];
      if(writer){
        const audit=(await pool.query("SELECT row_security_active('public.fleet_tax_edit_audit'::regclass) AS rls")).rows[0];
        if(audit?.rls!==true)return "permissions_failed";
      }
    }catch{return "permissions_failed"}
    if(grants?.tx_write!==false||grants?.vehicle_write!==false||grants?.file_write!==false||
      grants?.tax_write!==writer)return "permissions_failed";
    let rows;
    try{
      rows=(await pool.query(
        "SELECT u.plate_number,d.expired_date::text AS due FROM public.fleet_units u "+
        "JOIN public.fleet_documents d ON d.fleet_unit_id=u.id AND d.company_id=u.company_id "+
        "WHERE u.company_id='3' AND d.doc_type='annual_vehicle_tax' ORDER BY u.plate_number"
      )).rows;
    }catch{return "evidence_failed"}
    if(rows.length!==3||rows[0].plate_number!=="B1649PNV"||rows[0].due!=="2027-11-11"||
       rows[1].plate_number!=="B1650PNV"||rows[1].due!=="2027-11-11"||
       rows[2].plate_number!=="B1926PDT"||rows[2].due!=="2026-12-30")return "evidence_failed";
    return "pass";
  }finally{await pool.end().catch(()=>{})}
}

export async function divaProdPreflight():Promise<Outcome>{
  const runtime=process.env.APP_ENV==="production"&&process.env.APP_BASE_URL===ORIGIN;
  if(!runtime)return {
    status:"blocked",checks:{read:"fail",edit:"fail"},
    diagnostics:{runtime:"fail",read:"not_set",edit:"not_set"}
  };
  const now=Date.now();
  if(cache&&now-cache.at<120000)return cache.promise;
  const promise=Promise.all([
    check(process.env.FLEET_DIVA_ASSET_DATABASE_URL_PROD,ROLES.read,false),
    check(process.env.FLEET_DIVA_TAX_DATABASE_URL_PROD,ROLES.edit,true)
  ]).then(([read,edit]):Outcome=>({
    status:read==="pass"&&edit==="pass"?"ready":"blocked",
    checks:{read:read==="pass"?"pass":"fail",edit:edit==="pass"?"pass":"fail"},
    diagnostics:{runtime:"pass",read,edit}
  })).catch(():Outcome=>({
    status:"blocked",checks:{read:"fail",edit:"fail"},
    diagnostics:{runtime:"pass",read:"connection_failed",edit:"connection_failed"}
  }));
  cache={at:now,promise};
  return promise;
}
