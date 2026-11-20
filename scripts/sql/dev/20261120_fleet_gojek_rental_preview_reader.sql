-- CST-DEV ONLY, review before any application; NEVER auto-run on Fleet PROD.
-- Preview reads existing Gojek/Fleet Company 1 rows; source Company 3 is denied by RLS.
-- Dedicated reader is a LOGIN/least-privilege role, never a Finance posting role.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fleet_dev_stage_reader'
                 AND rolcanlogin=true AND rolsuper=false AND rolbypassrls=false) THEN
    RAISE EXCEPTION 'Missing expected nonprivileged DEV Fleet reader';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                 WHERE oid='public.fleet_transactions'::regclass AND relrowsecurity=true) THEN
    RAISE EXCEPTION 'Company-scoped source RLS must be enabled';
  END IF;
END $guard$;

GRANT SELECT (report_id,gopay_reference_id)
  ON TABLE public.fleet_transactions TO fleet_dev_stage_reader;

DO $policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='fleet_transactions'
                   AND policyname='fleet_dev_stage_gojek_rental_preview_read') THEN
    CREATE POLICY fleet_dev_stage_gojek_rental_preview_read
      ON public.fleet_transactions AS PERMISSIVE
      FOR SELECT TO fleet_dev_stage_reader USING (company_id=1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='fleet_transactions'
                   AND policyname='fleet_dev_stage_gojek_rental_preview_guard') THEN
    CREATE POLICY fleet_dev_stage_gojek_rental_preview_guard
      ON public.fleet_transactions AS RESTRICTIVE
      FOR SELECT TO fleet_dev_stage_reader USING (company_id=1);
  END IF;
END $policy$;

DO $postflight$
BEGIN
  IF NOT has_column_privilege('fleet_dev_stage_reader','public.fleet_transactions','report_id','SELECT')
     OR NOT has_column_privilege('fleet_dev_stage_reader','public.fleet_transactions','gopay_reference_id','SELECT')
     OR has_table_privilege('fleet_dev_stage_reader','public.fleet_transactions','INSERT')
     OR has_table_privilege('fleet_dev_stage_reader','public.fleet_transactions','UPDATE')
     OR has_table_privilege('fleet_dev_stage_reader','public.accounting_entries','INSERT')
  THEN RAISE EXCEPTION 'GoPartner stage reader scope violation'; END IF;
END $postflight$;
COMMIT;
