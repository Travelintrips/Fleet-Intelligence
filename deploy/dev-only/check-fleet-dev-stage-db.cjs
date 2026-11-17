"use strict";

// Called only inside the isolated Fleet DEV API container after staged HTTP readiness.
// The active PostgreSQL credential comes from Fleet's private GCP-sourced environment;
// no credential, private user record, or SQL result row is printed.
const { Client } = require("pg");

async function main() {
  const url = process.env.SUPABASE_DATABASE_URL_DEV || "";
  if (!url.includes("xssrfshdrtdfupgqwfdw") ||
      !url.includes("fleet_dev_stage_reader") ||
      url.includes("nzdweipzckfszczzqtuw")) {
    throw new Error("Wrong Fleet DEV staging database identity");
  }
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 5000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT current_user AS login_role,
             current_setting('transaction_read_only') AS readonly,
             (SELECT COUNT(*)::int FROM public.companies) AS companies,
             (SELECT COUNT(*)::int FROM public.fleet_vehicles) AS vehicles,
             (SELECT COUNT(*)::int FROM public.fleet_transactions) AS transactions,
             (SELECT COUNT(*)::int FROM public.fleet_transactions WHERE company_id <> 1) AS other_company_transactions,
             has_table_privilege(current_user, 'public.fleet_vehicles', 'INSERT') AS may_insert,
             has_table_privilege(current_user, 'public.fleet_transactions', 'UPDATE') AS may_update
    `);
    const row = rows[0] || {};
    const valid = row.login_role === "fleet_dev_stage_reader" &&
      row.readonly === "on" &&
      Number(row.companies) === 1 &&
      Number(row.vehicles) >= 44 &&
      Number(row.transactions) >= 425 &&
      Number(row.other_company_transactions) === 0 &&
      row.may_insert === false &&
      row.may_update === false;
    if (!valid) throw new Error("Fleet DEV staging role/RLS/write-denial check failed");
    process.stdout.write(
      `PASS Fleet DEV stage SQL read-only/RLS: CST=1 vehicles=${row.vehicles} transactions=${row.transactions} other-company=0; write denied\n`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  // Do not print error.message: driver errors can contain connection details.
  process.stderr.write("FAIL Fleet DEV stage SQL read-only/RLS: " +
    (error instanceof Error ? error.name : "unknown") + "\n");
  process.exitCode = 1;
});
