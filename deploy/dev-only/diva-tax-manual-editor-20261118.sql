-- CST-DEV ONLY: xssrfshdrtdfupgqwfdw. Never run against PROD.
-- Dedicated role is NOLOGIN in practice until a separate DEV-only SCRAM secret is provisioned.
-- Exactly the three confirmed PT Diva Servis Wuling Cloud vehicles are writable.
BEGIN;
DO $guard$
BEGIN
 IF current_database() <> 'postgres' THEN RAISE EXCEPTION 'Wrong database'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.companies WHERE id=3 AND name='PT Diva Servis' AND is_active) THEN RAISE EXCEPTION 'Diva company missing'; END IF;
 IF (SELECT count(*) FROM public.fleet_units WHERE company_id='3' AND plate_number IN ('B1649PNV','B1650PNV','B1926PDT')) <> 3 THEN RAISE EXCEPTION 'Three Diva vehicles required'; END IF;
 IF (SELECT count(*) FROM public.fleet_documents d JOIN public.fleet_units u ON u.id=d.fleet_unit_id WHERE d.company_id='3' AND u.company_id='3' AND u.plate_number IN ('B1649PNV','B1650PNV','B1926PDT') AND d.doc_type='annual_vehicle_tax') <> 3 THEN RAISE EXCEPTION 'Three Diva annual tax documents required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.fleet_documents'::regclass AND relrowsecurity) THEN RAISE EXCEPTION 'RLS required'; END IF;
END $guard$;
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='fleet_diva_tax_editor_login_dev') THEN
  CREATE ROLE fleet_diva_tax_editor_login_dev LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2;
 END IF;
END $role$;
GRANT CONNECT ON DATABASE postgres TO fleet_diva_tax_editor_login_dev;
GRANT USAGE ON SCHEMA public TO fleet_diva_tax_editor_login_dev;
GRANT SELECT (id,company_id,plate_number) ON public.fleet_units TO fleet_diva_tax_editor_login_dev;
GRANT SELECT (id,company_id,fleet_unit_id,doc_type,issued_date,expired_date,status,notes,updated_at)
 ON public.fleet_documents TO fleet_diva_tax_editor_login_dev;
GRANT UPDATE (issued_date,expired_date,status,notes,updated_at)
 ON public.fleet_documents TO fleet_diva_tax_editor_login_dev;
DO $policy$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_units' AND policyname='fleet_diva_tax_editor_units') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_editor_units ON public.fleet_units AS PERMISSIVE FOR SELECT TO fleet_diva_tax_editor_login_dev USING (company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT''))';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_units' AND policyname='fleet_diva_tax_editor_units_boundary') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_editor_units_boundary ON public.fleet_units AS RESTRICTIVE FOR SELECT TO fleet_diva_tax_editor_login_dev USING (company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT''))';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_diva_tax_editor_docs_select') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_editor_docs_select ON public.fleet_documents AS PERMISSIVE FOR SELECT TO fleet_diva_tax_editor_login_dev USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (2,3,4))';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_diva_tax_editor_docs_select_boundary') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_editor_docs_select_boundary ON public.fleet_documents AS RESTRICTIVE FOR SELECT TO fleet_diva_tax_editor_login_dev USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (2,3,4))';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_diva_tax_editor_docs_update') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_editor_docs_update ON public.fleet_documents AS PERMISSIVE FOR UPDATE TO fleet_diva_tax_editor_login_dev USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (2,3,4)) WITH CHECK (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (2,3,4))';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_documents' AND policyname='fleet_diva_tax_editor_docs_update_boundary') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_editor_docs_update_boundary ON public.fleet_documents AS RESTRICTIVE FOR UPDATE TO fleet_diva_tax_editor_login_dev USING (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (2,3,4)) WITH CHECK (company_id = ''3'' AND doc_type = ''annual_vehicle_tax'' AND fleet_unit_id IN (2,3,4))';
 END IF;
END $policy$;
-- Append-only (for this editor) evidence of every manual change.
CREATE TABLE IF NOT EXISTS public.fleet_tax_edit_audit_dev (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id text NOT NULL CHECK (company_id='3'),
 document_id integer NOT NULL,
 plate_number text NOT NULL CHECK (plate_number IN ('B1649PNV','B1650PNV','B1926PDT')),
 actor text NOT NULL CHECK(length(actor)>2),
 before_state jsonb NOT NULL,
 after_state jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fleet_tax_edit_audit_dev ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SEQUENCE public.fleet_tax_edit_audit_dev_id_seq TO fleet_diva_tax_editor_login_dev;
GRANT INSERT (company_id,document_id,plate_number,actor,before_state,after_state) ON public.fleet_tax_edit_audit_dev TO fleet_diva_tax_editor_login_dev;
GRANT SELECT (id,company_id,plate_number,actor,before_state,after_state,changed_at) ON public.fleet_tax_edit_audit_dev TO fleet_dev_stage_reader;
DO $audit_policies$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_tax_edit_audit_dev' AND policyname='fleet_diva_tax_editor_audit_insert') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_editor_audit_insert ON public.fleet_tax_edit_audit_dev FOR INSERT TO fleet_diva_tax_editor_login_dev WITH CHECK (company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT''))';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_tax_edit_audit_dev' AND policyname='fleet_diva_tax_owner_audit_read') THEN
  EXECUTE 'CREATE POLICY fleet_diva_tax_owner_audit_read ON public.fleet_tax_edit_audit_dev FOR SELECT TO fleet_dev_stage_reader USING (company_id = ''3'' AND plate_number IN (''B1649PNV'',''B1650PNV'',''B1926PDT''))';
 END IF;
END $audit_policies$;
-- The existing stage reader stays strictly read-only, gaining only version identifiers.
GRANT SELECT (id,updated_at) ON public.fleet_documents TO fleet_dev_stage_reader;
COMMIT;
