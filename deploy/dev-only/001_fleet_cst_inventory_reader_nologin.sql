-- CST-DEV ONLY. Manually apply against project xssrfshdrtdfupgqwfdw.
-- This script is NOT part of the automatic Fleet production schema migrations.
-- No login, password, broader permissions or dispatch authorization is created.
-- RLS remains enabled. Caller MUST independently verify role grants/policies
-- before considering a separate, restricted login credential.
CREATE ROLE fleet_dev_cst_inventory_reader
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  CONNECTION LIMIT 0;

ALTER ROLE fleet_dev_cst_inventory_reader SET default_transaction_read_only = on;
ALTER ROLE fleet_dev_cst_inventory_reader SET statement_timeout = '5s';
ALTER ROLE fleet_dev_cst_inventory_reader SET lock_timeout = '1s';
ALTER ROLE fleet_dev_cst_inventory_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE fleet_dev_cst_inventory_reader SET search_path = pg_catalog, public;

GRANT CONNECT ON DATABASE postgres TO fleet_dev_cst_inventory_reader;
GRANT USAGE ON SCHEMA public TO fleet_dev_cst_inventory_reader;

-- Fleet current vehicle route selects v.*; the employee/transaction tables
-- are deliberately column-restricted.
GRANT SELECT ON public.fleet_vehicles TO fleet_dev_cst_inventory_reader;
GRANT SELECT (id, company_id, full_name, driver_external_id,
              status, applicator_status, source_present_in_latest_snapshot,
              source_last_synced_at)
  ON public.fleet_drivers TO fleet_dev_cst_inventory_reader;
GRANT SELECT (company_id, vehicle_plate, transaction_date)
  ON public.fleet_transactions TO fleet_dev_cst_inventory_reader;
GRANT SELECT (id, code, is_active)
  ON public.companies TO fleet_dev_cst_inventory_reader;

CREATE POLICY fleet_dev_cst_inventory_select
  ON public.fleet_vehicles FOR SELECT
  TO fleet_dev_cst_inventory_reader USING (company_id = 1);
CREATE POLICY fleet_dev_cst_driver_select
  ON public.fleet_drivers FOR SELECT
  TO fleet_dev_cst_inventory_reader USING (company_id = '1');
CREATE POLICY fleet_dev_cst_transaction_select
  ON public.fleet_transactions FOR SELECT
  TO fleet_dev_cst_inventory_reader USING (company_id = 1);
CREATE POLICY fleet_dev_cst_company_select
  ON public.companies FOR SELECT
  TO fleet_dev_cst_inventory_reader
  USING (id = 1 AND code = 'CST' AND is_active IS TRUE);

COMMENT ON ROLE fleet_dev_cst_inventory_reader IS
  'CST-DEV private Fleet inventory evidence reader only; NOLOGIN until restricted database E2E gate; never promote to PROD';
