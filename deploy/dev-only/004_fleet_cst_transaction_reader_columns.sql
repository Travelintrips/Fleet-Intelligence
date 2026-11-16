-- CST-DEV ONLY. Apply only to Supabase project xssrfshdrtdfupgqwfdw.
-- A targeted SELECT-column allowance for the existing pinned-Google DEV
-- Super Admin Transactions page; no INSERT/UPDATE/DELETE or SELECT *.
-- Keep Fleet PROD and its roles unchanged.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fleet_dev_cst_inventory_reader')
  THEN RAISE EXCEPTION 'DEV-only reader role missing, abort'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='fleet_transactions'
      AND policyname='fleet_dev_cst_transaction_select'
      AND qual LIKE '%company_id = 1%'
  ) THEN RAISE EXCEPTION 'CST-only transaction SELECT RLS missing, abort'; END IF;
END $$;

-- The endpoint will use explicit columns instead of SELECT *.
-- Never grant raw_data, driver_phone, gopay_reference_id or created_at.
GRANT SELECT (
  id, driver_external_id, driver_name,
  trip_count, gross_revenue, incentive, commission, deduction,
  net_revenue, outstanding_balance, service_type, ppn_rate, ppn_amount,
  amount, transaction_type
) ON TABLE public.fleet_transactions TO fleet_dev_cst_inventory_reader;

-- Required for the pre-existing exact driver-name and vehicle-plate
-- eligibility predicate; its company-scoped RLS policy remains intact.
GRANT SELECT (vehicle_plate)
  ON TABLE public.fleet_drivers TO fleet_dev_cst_inventory_reader;

-- Allow only the aggregate source row count, never raw source content.
GRANT SELECT (company_id)
  ON TABLE public.gojek_raw_transactions TO fleet_dev_cst_inventory_reader;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='gojek_raw_transactions'
      AND policyname='fleet_dev_cst_raw_tx_company_select'
  ) THEN
    CREATE POLICY fleet_dev_cst_raw_tx_company_select
      ON public.gojek_raw_transactions
      FOR SELECT TO fleet_dev_cst_inventory_reader
      USING (company_id = 1);
  END IF;
END $$;
