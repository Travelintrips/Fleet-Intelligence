import pg from "pg";
import { X509Certificate } from "node:crypto";
import { SUPABASE_FINANCE_ROOT_2021_PEM, SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256 } from "./supabase-finance-root-2021";

const PROJECT = "xssrfshdrtdfupgqwfdw";
const ROLE = "fleet_diva_tax_editor_login_dev";
let dedicatedPool: pg.Pool | null = null;
let verified: Promise<void> | null = null;

export function divaTaxWriterEnabled(): boolean {
  return process.env.APP_ENV === "development" && process.env.FLEET_DIVA_TAX_EDIT_ENABLED_DEV === "true";
}

export function divaTaxPoolOptions(raw: string): pg.PoolConfig {
  if (!divaTaxWriterEnabled()) throw new Error("DIVA_TAX_DEV_DISABLED");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("DIVA_TAX_DATABASE_INVALID"); }
  const host = url.hostname.toLowerCase();
  const direct = host === "db." + PROJECT + ".supabase.co";
  const pooler = host.endsWith(".pooler.supabase.com");
  const user = decodeURIComponent(url.username);
  const port = Number(url.port || 5432);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      (!direct && !pooler) || (direct ? user !== ROLE : user !== ROLE + "." + PROJECT) ||
      !url.password || decodeURIComponent(url.pathname.slice(1)) !== "postgres" ||
      ![5432, 6543].includes(port) || (direct && port !== 5432) ||
      !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")) {
    throw new Error("DIVA_TAX_DATABASE_IDENTITY_INVALID");
  }
  const cert = new X509Certificate(SUPABASE_FINANCE_ROOT_2021_PEM);
  if (!cert.ca || cert.fingerprint256 !== SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256) {
    throw new Error("DIVA_TAX_CA_INVALID");
  }
  return {
    host, port, user, password: decodeURIComponent(url.password), database: "postgres",
    ssl: { rejectUnauthorized: true, servername: host, ca: SUPABASE_FINANCE_ROOT_2021_PEM },
    max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 5000,
    query_timeout: 15000, application_name: "fleet-diva-tax-editor-dev",
  };
}

async function connectPool(): Promise<pg.Pool> {
  if (!divaTaxWriterEnabled()) throw new Error("DIVA_TAX_DEV_DISABLED");
  const raw = process.env.FLEET_DIVA_TAX_DATABASE_URL_DEV?.trim();
  if (!raw) throw new Error("DIVA_TAX_DATABASE_NOT_CONFIGURED");
  if (!dedicatedPool) dedicatedPool = new pg.Pool(divaTaxPoolOptions(raw));
  if (!verified) {
    verified = dedicatedPool.query(
      "SELECT current_user::text role,session_user::text login_role,rolsuper,rolbypassrls," +
      "row_security_active('public.fleet_documents'::regclass) docs_rls," +
      "row_security_active('public.fleet_units'::regclass) units_rls," +
      "row_security_active('public.fleet_tax_edit_audit_dev'::regclass) audit_rls," +
      "has_column_privilege(current_user,'public.fleet_documents','expired_date','UPDATE') can_edit_due," +
      "has_column_privilege(current_user,'public.fleet_documents','file_url','UPDATE') can_edit_file," +
      "has_table_privilege(current_user,'public.fleet_cash_payments','INSERT') can_insert_payment " +
      "FROM pg_roles WHERE rolname=current_user"
    ).then(({rows}) => {
      const x = rows[0];
      if (x?.role !== ROLE || x?.login_role !== ROLE || x?.rolsuper !== false ||
          x?.rolbypassrls !== false || x?.docs_rls !== true || x?.units_rls !== true ||
          x?.audit_rls !== true || x?.can_edit_due !== true ||
          x?.can_edit_file !== false || x?.can_insert_payment !== false) {
        throw new Error("DIVA_TAX_DEV_ROLE_OR_RLS_INVALID");
      }
    }).catch(e => { verified=null; throw e; });
  }
  await verified;
  return dedicatedPool;
}

export const divaTaxWriterPool = {
  connect: async () => (await connectPool()).connect(),
  end: async () => {
    const pool = dedicatedPool;
    dedicatedPool = null; verified = null;
    if (pool) await pool.end();
  },
};
