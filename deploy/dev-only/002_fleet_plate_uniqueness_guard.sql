-- CST-DEV ONLY: Fleet source CSV anti-duplicate hardening.
-- Manually apply ONLY to Supabase project xssrfshdrtdfupgqwfdw.
-- NOT part of any automatic production migration and NOT a Fleet import.
-- Preserve existing driver / vehicle schema, APIs, sessions and scheduler.
--
-- Preconditions deliberately fail closed on PROD or non-empty Fleet DEV.
DO $dev_guard$
BEGIN
  IF to_regrole('fleet_dev_cst_inventory_reader') IS NULL THEN
    RAISE EXCEPTION 'CST_DEV_FLEET_READER_ROLE_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fleet_vehicles) THEN
    RAISE EXCEPTION 'CST_DEV_FLEET_MUST_BE_EMPTY_BEFORE_UNIQUE_GUARD';
  END IF;
END
$dev_guard$;

-- Matches the vehicle lookup's canonical plate-key normalization.
-- Same physical plate cannot be inserted twice in one company, regardless
-- of case, spaces or punctuation. Other companies have independent keys.
-- Full-snapshot import must reject/review source duplicates before retrying.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_vehicles_company_platekey_uniq_dev_20261116
  ON public.fleet_vehicles (
    company_id,
    upper(regexp_replace(coalesce(plate,''),'[^[:alnum:]]','','g'))
  )
  WHERE NULLIF(btrim(plate),'') IS NOT NULL;
