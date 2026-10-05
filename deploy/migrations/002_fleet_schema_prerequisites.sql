-- Standalone Fleet schema prerequisites.
-- Apply in DEV before running the standalone service.
-- Production only after DEV parity and cutover approval.

create table if not exists public.fleet_outstanding (
  id bigserial primary key,
  company_id integer not null,
  driver_id integer,
  driver_external_id text,
  driver_name text not null,
  driver_phone text,
  vehicle_plate text,
  outstanding_amount numeric(18,2) not null default 0,
  rental_fee_daily numeric(18,2) not null default 0,
  last_updated_date date,
  status text not null default 'open',
  snapshot_source text,
  due_days integer not null default 0,
  notes text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fleet_outstanding_company_status_idx
  on public.fleet_outstanding(company_id,status);

create table if not exists public.fleet_outstanding_import_log (
  id bigserial primary key,
  company_id integer not null,
  report_file_name text not null,
  uploaded_by text,
  uploaded_at timestamptz not null default now(),
  total_rows integer not null default 0,
  rows_imported integer not null default 0,
  rows_skipped integer not null default 0,
  unmatched_drivers integer not null default 0,
  notes text
);

alter table if exists public.fleet_drivers add column if not exists rental_fee_daily numeric(18,2) default 0;
alter table if exists public.fleet_drivers add column if not exists vehicle_plate text;
alter table if exists public.fleet_drivers add column if not exists vehicle_type text;
alter table if exists public.fleet_drivers add column if not exists applicator_status text;
alter table if exists public.fleet_drivers add column if not exists vehicle_ownership text;
alter table if exists public.fleet_drivers add column if not exists source_last_synced_at timestamptz;
alter table if exists public.fleet_drivers add column if not exists last_active_date date;
alter table if exists public.fleet_drivers add column if not exists total_trips integer not null default 0;
alter table if exists public.fleet_drivers add column if not exists total_revenue numeric(18,2) not null default 0;
alter table if exists public.fleet_drivers add column if not exists avg_daily_trips numeric(8,2) not null default 0;
alter table if exists public.fleet_drivers add column if not exists performance_tier text not null default 'standard';
alter table if exists public.fleet_drivers add column if not exists raw_data jsonb;
alter table if exists public.fleet_drivers add column if not exists source_present_in_latest_snapshot boolean not null default true;
alter table if exists public.fleet_drivers add column if not exists source_missing_since timestamptz;

create table if not exists public.fleet_expense_budgets (
  id bigserial primary key,
  company_id integer not null,
  expense_type text not null,
  budget_month date not null,
  budget_amount numeric(18,2) not null check (budget_amount >= 0),
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id,expense_type,budget_month)
);

create index if not exists fleet_expense_budgets_company_month_idx
  on public.fleet_expense_budgets(company_id,budget_month);

alter table public.fleet_outstanding enable row level security;
alter table public.fleet_outstanding_import_log enable row level security;
alter table public.fleet_expense_budgets enable row level security;
