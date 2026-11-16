-- CST-DEV ONLY. Apply to Supabase project xssrfshdrtdfupgqwfdw.
-- Preserve source events with different exact timestamps on the same day.
-- Do not run in PROD; do not replace the already-PASS GoPay reference index.
--
-- The former raw no-ref unique index used (company,driver,day,amount,type).
-- This merged distinct official Gojek events that occurred seconds apart.
-- Date & Time(JKT) is retained in date_time_jkt by the canonical importer.
--
-- Fail closed if any actual transaction rows have already been imported:
-- any pre-existing data requires a separate migration review.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.gojek_raw_transactions) THEN
    RAISE EXCEPTION 'DEV timestamp dedup migration requires empty gojek_raw_transactions; no data modified';
  END IF;
END;
$$;

DROP INDEX IF EXISTS public.gojek_raw_no_ref_dedup;

CREATE UNIQUE INDEX gojek_raw_no_ref_dedup
  ON public.gojek_raw_transactions (
    company_id,
    COALESCE(NULLIF(btrim(driver_external_id), ''), ''),
    COALESCE(date_iso, DATE '0001-01-01'),
    COALESCE(NULLIF(btrim(date_time_jkt), ''), ''),
    COALESCE(amount, 0),
    COALESCE(NULLIF(btrim(transaction_type), ''), '')
  )
  WHERE gopay_transaction_reference_id IS NULL
     OR gopay_transaction_reference_id = '';
