-- Fleet Intelligence standalone-owned runtime tables.
-- Apply to DEV first. Production only after standalone parity is approved.

create table if not exists public.fleet_wa_worker_state (
  company_id integer primary key,
  last_tick_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  sender_device text,
  device_status text,
  last_result jsonb,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.fleet_settings (
  company_id integer primary key,
  auto_blast_enabled boolean not null default false,
  auto_blast_hour integer not null default 8 check (auto_blast_hour between 0 and 23),
  auto_blast_last_run timestamptz,
  fleet_cash_account_id integer,
  fleet_driver_receivable_account_id integer,
  journal_id integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fleet_wa_worker_state enable row level security;
alter table public.fleet_settings enable row level security;
