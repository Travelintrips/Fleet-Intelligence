-- CST-DEV only (xssrfshdrtdfupgqwfdw).
-- Read-only PT Diva Servis asset registry for the existing Fleet DEV staging reader.
-- Do not grant SELECT on operational transactions/driver tables for company 3.
BEGIN;
DO $preflight$
BEGIN
 IF current_database() <> 'postgres' THEN RAISE EXCEPTION 'Expected postgres'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fleet_dev_stage_reader' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN
   RAISE EXCEPTION 'Existing scoped Fleet stage reader unavailable';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.fleet_units'::regclass AND relrowsecurity) THEN
   RAISE EXCEPTION 'fleet_units RLS required';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id=3 AND name='PT Diva Servis' AND is_active=true) THEN
   RAISE EXCEPTION 'PT Diva Servis company master mismatch';
 END IF;
 IF (SELECT count(*) FROM public.fleet_units WHERE company_id='3' AND plate_number IN('B1649PNV','B1650PNV','B1926PDT'))<>3 THEN
   RAISE EXCEPTION 'Three confirmed Diva unit rows required';
 END IF;
END $preflight$;
GRANT SELECT (company_id,plate_number,brand,model,ownership_type,status,unit_number)
  ON public.fleet_units TO fleet_dev_stage_reader;
DO $policy$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_units' AND policyname='fleet_dev_diva_asset_read') THEN
  EXECUTE 'CREATE POLICY fleet_dev_diva_asset_read ON public.fleet_units AS PERMISSIVE FOR SELECT TO fleet_dev_stage_reader USING (company_id = ''3'')';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_units' AND policyname='fleet_dev_diva_asset_boundary') THEN
  EXECUTE 'CREATE POLICY fleet_dev_diva_asset_boundary ON public.fleet_units AS RESTRICTIVE FOR SELECT TO fleet_dev_stage_reader USING (company_id = ''3'')';
 END IF;
END $policy$;
COMMIT;
