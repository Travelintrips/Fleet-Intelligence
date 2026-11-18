-- CST-DEV ONLY project xssrfshdrtdfupgqwfdw. Run only on the already verified company 3 assets.
-- No production migration or write privilege; protect STNK identifiers/notes/files by column grants.
BEGIN;
DO $guard$
BEGIN
 IF current_database() <> 'postgres' THEN RAISE EXCEPTION 'Expected postgres'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fleet_dev_stage_reader' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'Unexpected Fleet reader role'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.fleet_documents'::regclass AND relrowsecurity) THEN RAISE EXCEPTION 'fleet_documents RLS required'; END IF;
 IF (SELECT count(*) FROM public.fleet_units WHERE company_id='3' AND plate_number IN ('B1649PNV','B1650PNV','B1926PDT')) <> 3 THEN RAISE EXCEPTION 'Diva company 3 assets missing'; END IF;
END $guard$;
GRANT SELECT (id) ON public.fleet_units TO fleet_dev_stage_reader;
GRANT SELECT (company_id,fleet_unit_id,doc_type,issued_date,expired_date,status,reminder_days)
  ON public.fleet_documents TO fleet_dev_stage_reader;
DO $pol$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_dev_diva_tax_read') THEN
  EXECUTE 'CREATE POLICY fleet_dev_diva_tax_read ON public.fleet_documents AS PERMISSIVE FOR SELECT TO fleet_dev_stage_reader USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'')';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_dev_diva_tax_boundary') THEN
  EXECUTE 'CREATE POLICY fleet_dev_diva_tax_boundary ON public.fleet_documents AS RESTRICTIVE FOR SELECT TO fleet_dev_stage_reader USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'')';
 END IF;
END $pol$;
COMMIT;
