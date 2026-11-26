-- Fleet PROD: register PT Diva Servis assets with the existing scoped editor.
-- Target project: nzdweipzckfszczzqtuw. Apply explicitly after isolated SQL tests.
-- This migration creates no credentials, changes no existing asset values, and
-- grants no access to operational Fleet, Gojek, drivers, or Finance data.
BEGIN;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '60000ms';
SELECT pg_advisory_xact_lock(hashtext('fleet-prod-diva-asset-registration-20261126'));

DO $preflight$
DECLARE
  relation_name text;
  role_name text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Authorized Fleet PROD postgres only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companies
    WHERE id = 3 AND name = 'PT Diva Servis' AND is_active
  ) THEN
    RAISE EXCEPTION 'Active PT Diva Servis Company 3 is required';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['fleet_units', 'fleet_documents', 'fleet_tax_edit_audit'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = relation_name
        AND c.relkind = 'r' AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Existing public.% with RLS is required', relation_name;
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['fleet_diva_asset_reader_login_prod', 'fleet_diva_tax_editor_login_prod'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = role_name
        AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit
        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
    ) THEN
      RAISE EXCEPTION 'Existing restricted role % is required', role_name;
    END IF;
  END LOOP;
END
$preflight$;

-- Enforce uniqueness even when callers race, retry, or use spaces/punctuation.
-- Other companies retain their existing indexes and data rules.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_diva_units_plate_normalized_uidx
  ON public.fleet_units ((upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g'))))
  WHERE company_id = '3';
CREATE UNIQUE INDEX IF NOT EXISTS fleet_diva_unit_chassis_normalized_uidx
  ON public.fleet_units ((upper(regexp_replace(chassis_number, '[^A-Za-z0-9]', '', 'g'))))
  WHERE company_id = '3'
    AND nullif(regexp_replace(chassis_number, '[^A-Za-z0-9]', '', 'g'), '') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fleet_diva_unit_engine_normalized_uidx
  ON public.fleet_units ((upper(regexp_replace(engine_number, '[^A-Za-z0-9]', '', 'g'))))
  WHERE company_id = '3'
    AND nullif(regexp_replace(engine_number, '[^A-Za-z0-9]', '', 'g'), '') IS NOT NULL;

GRANT INSERT (
  company_id, unit_number, plate_number, vehicle_type, brand, model, year,
  chassis_number, engine_number, color, fuel_type, ownership_type, status,
  is_active, notes, created_by
) ON public.fleet_units TO fleet_diva_tax_editor_login_prod;
GRANT SELECT (id, company_id, plate_number, chassis_number, engine_number, ownership_type)
  ON public.fleet_units TO fleet_diva_tax_editor_login_prod;
GRANT INSERT (
  company_id, fleet_unit_id, doc_type, issued_date, expired_date, issuing_authority,
  status, reminder_days, notes, created_by
) ON public.fleet_documents TO fleet_diva_tax_editor_login_prod;
GRANT SELECT (id, updated_at) ON public.fleet_documents TO fleet_diva_tax_editor_login_prod;
GRANT USAGE ON SEQUENCE public.fleet_units_id_seq, public.fleet_documents_id_seq
  TO fleet_diva_tax_editor_login_prod;

-- Replace only this feature's policies. Existing policies for other roles stay.
DROP POLICY IF EXISTS fleet_diva_prod_reader_units ON public.fleet_units;
CREATE POLICY fleet_diva_prod_reader_units ON public.fleet_units
  FOR SELECT TO fleet_diva_asset_reader_login_prod
  USING (company_id = '3' AND ownership_type = 'own');
DROP POLICY IF EXISTS fleet_diva_prod_editor_units ON public.fleet_units;
CREATE POLICY fleet_diva_prod_editor_units ON public.fleet_units
  FOR SELECT TO fleet_diva_tax_editor_login_prod
  USING (company_id = '3' AND ownership_type = 'own');
DROP POLICY IF EXISTS fleet_diva_prod_editor_units_insert ON public.fleet_units;
CREATE POLICY fleet_diva_prod_editor_units_insert ON public.fleet_units
  FOR INSERT TO fleet_diva_tax_editor_login_prod
  WITH CHECK (
    company_id = '3' AND ownership_type = 'own'
    AND status = 'registered' AND is_active IS TRUE
    AND plate_number ~ '^[A-Z]{1,3}[0-9]{1,4}[A-Z]{0,3}$'
  );

DROP POLICY IF EXISTS fleet_diva_prod_reader_tax ON public.fleet_documents;
CREATE POLICY fleet_diva_prod_reader_tax ON public.fleet_documents
  FOR SELECT TO fleet_diva_asset_reader_login_prod
  USING (
    company_id = '3' AND doc_type = 'annual_vehicle_tax'
    AND EXISTS (
      SELECT 1 FROM public.fleet_units u
      WHERE u.id = fleet_documents.fleet_unit_id
        AND u.company_id = fleet_documents.company_id AND u.ownership_type = 'own'
    )
  );
DROP POLICY IF EXISTS fleet_diva_prod_editor_tax_read ON public.fleet_documents;
CREATE POLICY fleet_diva_prod_editor_tax_read ON public.fleet_documents
  FOR SELECT TO fleet_diva_tax_editor_login_prod
  USING (
    company_id = '3' AND doc_type = 'annual_vehicle_tax'
    AND EXISTS (
      SELECT 1 FROM public.fleet_units u
      WHERE u.id = fleet_documents.fleet_unit_id
        AND u.company_id = fleet_documents.company_id AND u.ownership_type = 'own'
    )
  );
DROP POLICY IF EXISTS fleet_diva_prod_editor_tax_update ON public.fleet_documents;
CREATE POLICY fleet_diva_prod_editor_tax_update ON public.fleet_documents
  FOR UPDATE TO fleet_diva_tax_editor_login_prod
  USING (
    company_id = '3' AND doc_type = 'annual_vehicle_tax'
    AND EXISTS (
      SELECT 1 FROM public.fleet_units u
      WHERE u.id = fleet_documents.fleet_unit_id
        AND u.company_id = fleet_documents.company_id AND u.ownership_type = 'own'
    )
  )
  WITH CHECK (
    company_id = '3' AND doc_type = 'annual_vehicle_tax'
    AND EXISTS (
      SELECT 1 FROM public.fleet_units u
      WHERE u.id = fleet_documents.fleet_unit_id
        AND u.company_id = fleet_documents.company_id AND u.ownership_type = 'own'
    )
  );
DROP POLICY IF EXISTS fleet_diva_prod_editor_tax_insert ON public.fleet_documents;
CREATE POLICY fleet_diva_prod_editor_tax_insert ON public.fleet_documents
  FOR INSERT TO fleet_diva_tax_editor_login_prod
  WITH CHECK (
    company_id = '3' AND doc_type = 'annual_vehicle_tax'
    AND EXISTS (
      SELECT 1 FROM public.fleet_units u
      WHERE u.id = fleet_documents.fleet_unit_id
        AND u.company_id = fleet_documents.company_id AND u.ownership_type = 'own'
    )
  );

-- Preserve previous audit entries, while permitting future owned Diva vehicles.
-- Creation uses before_state={} and after_state.action='asset_registered';
-- subsequent edits keep their existing before/after JSON contract.
ALTER TABLE public.fleet_tax_edit_audit
  DROP CONSTRAINT IF EXISTS fleet_tax_edit_audit_plate_number_check;
ALTER TABLE public.fleet_tax_edit_audit
  ADD CONSTRAINT fleet_tax_edit_audit_plate_number_check
  CHECK (plate_number ~ '^[A-Z]{1,3}[0-9]{1,4}[A-Z]{0,3}$');
DROP POLICY IF EXISTS fleet_diva_prod_audit_insert ON public.fleet_tax_edit_audit;
CREATE POLICY fleet_diva_prod_audit_insert ON public.fleet_tax_edit_audit
  FOR INSERT TO fleet_diva_tax_editor_login_prod
  WITH CHECK (
    company_id = '3'
    AND EXISTS (
      SELECT 1 FROM public.fleet_documents d
      JOIN public.fleet_units u ON u.id = d.fleet_unit_id AND u.company_id = d.company_id
      WHERE d.id = fleet_tax_edit_audit.document_id
        AND d.company_id = fleet_tax_edit_audit.company_id
        AND d.doc_type = 'annual_vehicle_tax' AND u.ownership_type = 'own'
        AND u.plate_number = fleet_tax_edit_audit.plate_number
    )
  );

DO $verify_scope$
DECLARE
  relation_name text;
  role_name text;
BEGIN
  IF has_any_column_privilege('fleet_diva_asset_reader_login_prod', 'public.fleet_units', 'INSERT,UPDATE')
    OR has_any_column_privilege('fleet_diva_asset_reader_login_prod', 'public.fleet_documents', 'INSERT,UPDATE')
    OR has_table_privilege('fleet_diva_asset_reader_login_prod', 'public.fleet_units', 'DELETE,TRUNCATE')
    OR has_table_privilege('fleet_diva_asset_reader_login_prod', 'public.fleet_documents', 'DELETE,TRUNCATE')
    OR has_any_column_privilege('fleet_diva_tax_editor_login_prod', 'public.fleet_units', 'UPDATE')
    OR has_table_privilege('fleet_diva_tax_editor_login_prod', 'public.fleet_units', 'DELETE,TRUNCATE')
    OR has_table_privilege('fleet_diva_tax_editor_login_prod', 'public.fleet_documents', 'DELETE,TRUNCATE')
    OR has_column_privilege('fleet_diva_tax_editor_login_prod', 'public.fleet_documents', 'file_url', 'INSERT,UPDATE')
    OR has_any_column_privilege('fleet_diva_tax_editor_login_prod', 'public.fleet_tax_edit_audit', 'UPDATE')
    OR has_table_privilege('fleet_diva_tax_editor_login_prod', 'public.fleet_tax_edit_audit', 'DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'Diva reader/editor scope exceeds the approved asset registration path';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['fleet_diva_asset_reader_login_prod', 'fleet_diva_tax_editor_login_prod'] LOOP
    FOREACH relation_name IN ARRAY ARRAY['fleet_vehicles', 'fleet_drivers', 'fleet_transactions', 'fleet_outstanding'] LOOP
      IF to_regclass('public.' || relation_name) IS NOT NULL AND (
        has_any_column_privilege(role_name, 'public.' || relation_name, 'INSERT,UPDATE')
        OR has_table_privilege(role_name, 'public.' || relation_name, 'DELETE,TRUNCATE')
      ) THEN
        RAISE EXCEPTION 'Unexpected operational write privilege for % on %', role_name, relation_name;
      END IF;
    END LOOP;
  END LOOP;
END
$verify_scope$;
COMMIT;
