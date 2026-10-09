CREATE TABLE IF NOT EXISTS public.fleet_group_report_log (
  report_key text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('sending','accepted','failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
