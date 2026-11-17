import pg from "pg";
import { X509Certificate } from "node:crypto";
import { pool as inventoryPool } from "./db";
import { SUPABASE_FINANCE_ROOT_2021_PEM, SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256 } from "./supabase-finance-root-2021";

const PROJECT = "xssrfshdrtdfupgqwfdw";
const ROLE = "fleet_cash_source_login_dev";
let dedicatedPool: pg.Pool | null = null;
let activeUrl: string | null = null;
let verification: Promise<void> | null = null;

export function isFleetCashDevEnabled(): boolean {
  return process.env.APP_ENV === "development" && process.env.FLEET_CASH_DATABASE_ENABLED_DEV === "true";
}

/** Only the cash source service selects this credential; the inventory pool is unchanged. */
export function fleetCashPoolOptions(raw: string): pg.PoolConfig {
  if (process.env.APP_ENV !== "development" || process.env.FLEET_CASH_DATABASE_ENABLED_DEV !== "true") {
    throw new Error("FLEET_CASH_DEV_DATABASE_DISABLED");
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("FLEET_CASH_DEV_DATABASE_INVALID"); }
  const host = url.hostname.toLowerCase();
  const user = decodeURIComponent(url.username);
  const port = Number(url.port || 5432);
  const direct = host === "db." + PROJECT + ".supabase.co";
  const pooler = host.endsWith(".pooler.supabase.com");
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      (!direct && !pooler) || (direct ? user !== ROLE : user !== ROLE + "." + PROJECT) ||
      !url.password || decodeURIComponent(url.pathname.slice(1)) !== "postgres" ||
      ![5432, 6543].includes(port) || (direct && port !== 5432) ||
      !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")) {
    throw new Error("FLEET_CASH_DEV_DATABASE_IDENTITY_INVALID");
  }
  let ca: string | undefined;
  if (direct) {
    const cert = new X509Certificate(SUPABASE_FINANCE_ROOT_2021_PEM);
    if (!cert.ca || cert.fingerprint256 !== SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256) {
      throw new Error("FLEET_CASH_DEV_CA_INVALID");
    }
    ca = SUPABASE_FINANCE_ROOT_2021_PEM;
  }
  return {
    host, port, user, password: decodeURIComponent(url.password), database: "postgres",
    ssl: { rejectUnauthorized: true, servername: host, ...(ca ? { ca } : {}) },
    max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 5000,
    query_timeout: 20000, application_name: "fleet-cash-source-dev",
  };
}

async function selectedPool(): Promise<pg.Pool> {
  if (process.env.FLEET_CASH_DATABASE_ENABLED_DEV === "true" && process.env.APP_ENV !== "development") {
    throw new Error("FLEET_CASH_DEV_ONLY");
  }
  if (!isFleetCashDevEnabled()) {
    if (process.env.APP_ENV === "development" && process.env.CENTRAL_FINANCE_WRITE_ENABLED?.toLowerCase() === "true") {
      throw new Error("FLEET_CASH_DEV_DATABASE_REQUIRED");
    }
    return inventoryPool;
  }
  const raw = process.env.FLEET_CASH_DATABASE_URL_DEV?.trim() ?? "";
  if (!raw) throw new Error("FLEET_CASH_DEV_DATABASE_REQUIRED");
  if (activeUrl && activeUrl !== raw) throw new Error("FLEET_CASH_DEV_DATABASE_CHANGED_RESTART_REQUIRED");
  if (!dedicatedPool) {
    dedicatedPool = new pg.Pool(fleetCashPoolOptions(raw));
    activeUrl = raw;
  }
  if (!verification) {
    const selected = dedicatedPool;
    verification = selected.query(
      "SELECT current_user::text AS role,session_user::text AS login_role,rolsuper,rolbypassrls," +
      "row_security_active('public.fleet_cash_payments'::regclass) AS cash_rls," +
      "row_security_active('public.fleet_outstanding'::regclass) AS outstanding_rls," +
      "row_security_active('public.accounting_entries'::regclass) AS receipt_rls " +
      "FROM pg_roles WHERE rolname=current_user"
    ).then(({ rows }) => {
      const identity = rows[0];
      if (identity?.role !== ROLE || identity?.login_role !== ROLE || identity?.rolsuper !== false ||
          identity?.rolbypassrls !== false || identity?.cash_rls !== true || identity?.outstanding_rls !== true || identity?.receipt_rls !== true) {
        throw new Error("FLEET_CASH_DEV_ROLE_OR_RLS_INVALID");
      }
    }).catch((error: unknown) => { verification = null; throw error; });
  }
  await verification;
  return dedicatedPool;
}

export const fleetCashPool = {
  query: async (...args: unknown[]) => {
    const selected = await selectedPool();
    return (selected.query as (...values: unknown[]) => unknown)(...args);
  },
  connect: async () => (await selectedPool()).connect(),
  end: async () => {
    const selected = dedicatedPool;
    dedicatedPool = null; activeUrl = null; verification = null;
    if (selected) await selected.end();
  },
} as unknown as pg.Pool;

export async function getFleetCashDatabaseStatus() {
  const enabled = isFleetCashDevEnabled();
  if (!enabled) return { enabled, sourceCompanyId: 1, readReady: false, writeReady: false, reason: "dedicated_database_disabled" };
  try {
    const result = await fleetCashPool.query(
      "SELECT has_table_privilege(current_user,'public.fleet_cash_payments','SELECT') AS cash_read," +
      "has_table_privilege(current_user,'public.fleet_outstanding','SELECT') AS outstanding_read," +
      "has_table_privilege(current_user,'public.fleet_cash_payments','INSERT') AS cash_insert," +
      "has_column_privilege(current_user,'public.fleet_cash_payments','status','UPDATE') AS cash_status_update," +
      "has_column_privilege(current_user,'public.fleet_cash_payments','accounting_entry_id','UPDATE') AS cash_link_update," +
      "has_column_privilege(current_user,'public.fleet_cash_payments','updated_at','UPDATE') AS cash_time_update," +
      "has_column_privilege(current_user,'public.fleet_outstanding','outstanding_amount','UPDATE') AS balance_update," +
      "has_column_privilege(current_user,'public.fleet_outstanding','status','UPDATE') AS outstanding_status_update," +
      "has_column_privilege(current_user,'public.fleet_outstanding','resolved_at','UPDATE') AS resolved_update," +
      "has_column_privilege(current_user,'public.fleet_outstanding','updated_at','UPDATE') AS outstanding_time_update," +
      "has_sequence_privilege(current_user,'public.fleet_cash_payments_id_seq','USAGE') AS sequence_use"
    );
    const row = result.rows[0] ?? {};
    const readReady = row.cash_read === true && row.outstanding_read === true;
    const writeReady = readReady && Object.values(row).every((value) => value === true);
    return { enabled, sourceCompanyId: 1, readReady, writeReady, reason: writeReady ? null : "source_permissions_incomplete" };
  } catch {
    return { enabled, sourceCompanyId: 1, readReady: false, writeReady: false, reason: "source_database_unavailable" };
  }
}
