-- Fleet PROD deployment gate; NOT run automatically.
-- Target project nzdweipzckfszczzqtuw ONLY.
-- Create the three PT Diva Servis assets without moving Gojek history.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('fleet-prod-diva-wuling-asset-release'));
DO $preflight$
BEGIN
 IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
   RAISE EXCEPTION 'Authorized Fleet PROD postgres only';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN RAISE EXCEPTION 'Unexpected PG instance'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.companies WHERE id=3 AND name='PT Diva Servis' AND is_active) THEN RAISE EXCEPTION 'Diva company missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.fleet_units'::regclass AND relrowsecurity) OR
    NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.fleet_documents'::regclass AND relrowsecurity) THEN
   RAISE EXCEPTION 'Both fleet_units and fleet_documents require RLS';
 END IF;
 IF EXISTS(SELECT 1 FROM public.fleet_units
           WHERE upper(regexp_replace(plate_number,'[^A-Za-z0-9]','','g')) IN ('B1649PNV','B1650PNV','B1926PDT')
             AND company_id<>'3') THEN RAISE EXCEPTION 'Vehicle registered under another legal entity'; END IF;
END $preflight$;
WITH desired(plate_number,unit_number) AS (
 VALUES ('B1649PNV','DVS-WULING-CLOUD-B1649PNV'),
        ('B1650PNV','DVS-WULING-CLOUD-B1650PNV'),
        ('B1926PDT','DVS-WULING-CLOUD-B1926PDT')
)
INSERT INTO public.fleet_units
(company_id,unit_number,plate_number,vehicle_type,brand,model,fuel_type,ownership_type,status,is_active,created_by,notes)
SELECT '3',d.unit_number,d.plate_number,'car','Wuling','Cloud EV','electric','own','registered',true,
       'owner-verified-prod-release',
       'PT Diva Servis-owned asset per owner confirmation. Does not migrate Company 1 Gojek operational history.'
FROM desired d
WHERE NOT EXISTS(SELECT 1 FROM public.fleet_units u
                 WHERE upper(regexp_replace(u.plate_number,'[^A-Za-z0-9]','','g'))=d.plate_number);
WITH desired(plate_number,paid_on,due_on,tax_status,tax_notes) AS (
 VALUES
  ('B1649PNV',DATE '2026-11-17',NULL::date,'paid_late_due_unverified',
   'Owner confirms annual tax due 11 Nov 2026, paid 17 Nov 2026 (6 days late due to document delay). New renewal expiry not entered until latest evidence verified.'),
  ('B1650PNV',DATE '2026-11-17',NULL::date,'paid_late_due_unverified',
   'Owner confirms annual tax due 11 Nov 2026, paid 17 Nov 2026 (6 days late due to document delay). New renewal expiry not entered until latest evidence verified.'),
  ('B1926PDT',NULL::date,DATE '2026-12-30','due_soon',
   'Annual tax due 30 Dec 2026; owner reports not renewed as of 18 Nov 2026.')
)
INSERT INTO public.fleet_documents
(company_id,fleet_unit_id,doc_type,issued_date,expired_date,issuing_authority,status,reminder_days,notes,created_by)
SELECT '3',u.id,'annual_vehicle_tax',d.paid_on,d.due_on,'Samsat DKI Jakarta',d.tax_status,30,d.tax_notes,'fleet-prod-diva-owner-release'
FROM desired d JOIN public.fleet_units u
 ON u.company_id='3' AND u.plate_number=d.plate_number
WHERE NOT EXISTS(SELECT 1 FROM public.fleet_documents fd
                 WHERE fd.fleet_unit_id=u.id AND fd.company_id='3' AND fd.doc_type='annual_vehicle_tax');
DO $verify$
BEGIN
 IF (SELECT count(*) FROM public.fleet_units WHERE company_id='3' AND plate_number IN ('B1649PNV','B1650PNV','B1926PDT'))<>3 THEN RAISE EXCEPTION 'Assets mismatch'; END IF;
 IF (SELECT count(*) FROM public.fleet_documents d JOIN public.fleet_units u ON u.id=d.fleet_unit_id
     WHERE d.company_id='3' AND u.company_id='3' AND u.plate_number IN ('B1649PNV','B1650PNV','B1926PDT') AND d.doc_type='annual_vehicle_tax')<>3 THEN RAISE EXCEPTION 'Tax record mismatch'; END IF;
END $verify$;
-- PROD role names and passwords are distinct from CST-DEV. Password NULL until explicitly provisioned.
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='fleet_diva_asset_reader_login_prod') THEN
  CREATE ROLE fleet_diva_asset_reader_login_prod LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='fleet_diva_tax_editor_login_prod') THEN
  CREATE ROLE fleet_diva_tax_editor_login_prod LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2;
 END IF;
END $roles$;
GRANT CONNECT ON DATABASE postgres TO fleet_diva_asset_reader_login_prod,fleet_diva_tax_editor_login_prod;
GRANT USAGE ON SCHEMA public TO fleet_diva_asset_reader_login_prod,fleet_diva_tax_editor_login_prod;
GRANT SELECT (id,company_id,plate_number,brand,model,ownership_type,status,unit_number)
 ON public.fleet_units TO fleet_diva_asset_reader_login_prod;
GRANT SELECT (id,company_id,plate_number) ON public.fleet_units TO fleet_diva_tax_editor_login_prod;
GRANT SELECT (id,company_id,fleet_unit_id,doc_type,issued_date,expired_date,status,reminder_days,updated_at)
 ON public.fleet_documents TO fleet_diva_asset_reader_login_prod;
GRANT SELECT (id,company_id,fleet_unit_id,doc_type,issued_date,expired_date,status,notes,updated_at)
 ON public.fleet_documents TO fleet_diva_tax_editor_login_prod;
GRANT UPDATE (issued_date,expired_date,status,notes,updated_at)
 ON public.fleet_documents TO fleet_diva_tax_editor_login_prod;
DO $policies$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_units' AND policyname='fleet_diva_prod_reader_units') THEN
 EXECUTE 'CREATE POLICY fleet_diva_prod_reader_units ON public.fleet_units FOR SELECT TO fleet_diva_asset_reader_login_prod USING (company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT''))'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_units' AND policyname='fleet_diva_prod_editor_units') THEN
 EXECUTE 'CREATE POLICY fleet_diva_prod_editor_units ON public.fleet_units FOR SELECT TO fleet_diva_tax_editor_login_prod USING (company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT''))'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_diva_prod_reader_tax') THEN
 EXECUTE 'CREATE POLICY fleet_diva_prod_reader_tax ON public.fleet_documents FOR SELECT TO fleet_diva_asset_reader_login_prod USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (SELECT id FROM public.fleet_units WHERE company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT'')))'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_diva_prod_editor_tax_read') THEN
 EXECUTE 'CREATE POLICY fleet_diva_prod_editor_tax_read ON public.fleet_documents FOR SELECT TO fleet_diva_tax_editor_login_prod USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (SELECT id FROM public.fleet_units WHERE company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT'')))'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_diva_prod_editor_tax_update') THEN
 EXECUTE 'CREATE POLICY fleet_diva_prod_editor_tax_update ON public.fleet_documents FOR UPDATE TO fleet_diva_tax_editor_login_prod USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (SELECT id FROM public.fleet_units WHERE company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT''))) WITH CHECK (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'')'; END IF;
END $policies$;
CREATE TABLE IF NOT EXISTS public.fleet_tax_edit_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id text NOT NULL CHECK (company_id='3'),
 document_id integer NOT NULL,
 plate_number text NOT NULL CHECK (plate_number IN ('B1649PNV','B1650PNV','B1926PDT')),
 actor text NOT NULL,
 before_state jsonb NOT NULL,
 after_state jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fleet_tax_edit_audit ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SEQUENCE public.fleet_tax_edit_audit_id_seq TO fleet_diva_tax_editor_login_prod;
GRANT INSERT (company_id,document_id,plate_number,actor,before_state,after_state) ON public.fleet_tax_edit_audit TO fleet_diva_tax_editor_login_prod;
DO $audit$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_tax_edit_audit' AND policyname='fleet_diva_prod_audit_insert') THEN
 EXECUTE 'CREATE POLICY fleet_diva_prod_audit_insert ON public.fleet_tax_edit_audit FOR INSERT TO fleet_diva_tax_editor_login_prod WITH CHECK (company_id=''3'')'; END IF;
END $audit$;
COMMIT;
