#!/usr/bin/env bash
# DEV-only, offline integration QA. No source or Finance database credentials.
set -Eeuo pipefail
umask 077
FLEET_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FINANCE_REPO="${FLEET_QA_FINANCE_REPO:-/opt/bizportal-fleet-finance-diva-20261117}"
DEPS="${FLEET_QA_DEPENDENCIES:-/opt/bizportal-20261117-audit-main-only}"
QA_DIR="$(mktemp -d /tmp/fleet-finance-dsv-qa-XXXXXXXX)"
SOCKET_DIR="$QA_DIR/pgsocket"
LOG_DIR="$(mktemp -d /tmp/fleet-qa-results-XXXXXXXX)"
NAME="fleet-finance-qa-$(basename "$QA_DIR" | tr -cd 'a-zA-Z0-9')"
started=0
cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [ "$started" -eq 1 ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf -- "$QA_DIR"
  printf 'QA logs: %s\n' "$LOG_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM
[ "$EUID" -eq 0 ] || { echo 'Run on authorized DEV host as root for Docker isolation' >&2; exit 1; }
[ -f "$FINANCE_REPO/scripts/fixtures/fleet-finance-dev-schema.sql" ] || { echo 'Canonical Finance fixture missing' >&2; exit 1; }
[ -f "$FINANCE_REPO/scripts/sql/dev/20261117143910_dev_fleet_finance_scoped_runtime_roles.sql" ] || { echo 'Canonical scoped RLS roles missing' >&2; exit 1; }
[ -f "$FLEET_REPO/scripts/test-fleet-cash-payment-recovery-postgres.mjs" ] || exit 1
[ -d "$DEPS/node_modules" ] || { echo 'Local canonical dependencies missing' >&2; exit 1; }
mkdir -p "$SOCKET_DIR"
chmod 0777 "$SOCKET_DIR" # Private randomized temp parent is still 0700; Docker postgres needs mount access.
echo 'QA boundary: disposable PostgreSQL 16, network=none, tmpfs, Unix socket only.'
echo 'Live Fleet DEV, live Finance DEV, and PROD remain untouched.'
docker image inspect postgres:16-alpine >/dev/null
docker run -d --name "$NAME" --network none \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=192m \
  -v "$SOCKET_DIR:/var/run/postgresql" \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine \
  -c listen_addresses='' -c unix_socket_directories=/var/run/postgresql >/dev/null
started=1
ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.3
done
[ "$ready" -eq 1 ] || { echo 'Database startup failed' >&2; exit 1; }
docker exec "$NAME" createdb -U postgres fleet_finance_qa
docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$FINANCE_REPO/scripts/fixtures/fleet-finance-dev-schema.sql" > "$LOG_DIR/schema.log"
docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_entry_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_cash_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_outstanding ENABLE ROW LEVEL SECURITY;
INSERT INTO public.companies(id,name,company_name,code,company_code,is_active)
VALUES (1,'QA Fleet Source','QA Fleet Source','QA-CST','QA-CST',true),
       (2,'QA Other','QA Other','QA-OTHER','QA-OTHER',true),
       (3,'PT Diva Servis','PT Diva Servis','DVS','DVS',true);
" > "$LOG_DIR/seed.log"
docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$FINANCE_REPO/scripts/sql/dev/20261117143910_dev_fleet_finance_scoped_runtime_roles.sql" > "$LOG_DIR/roles.log"
echo 'Running actual Finance receiver + scoped LOGIN/RLS (27 checks)...'
FLEET_QA_PG_SOCKET="$SOCKET_DIR" FLEET_QA_DEPENDENCIES="$DEPS" FLEET_QA_CLIENT_REPO="$FLEET_REPO" \
  node "$FINANCE_REPO/scripts/test-fleet-finance-dsv-postgres.mjs" > "$LOG_DIR/finance.log" 2>&1 || { tail -35 "$LOG_DIR/finance.log"; exit 1; }
grep -q '"testsPassed": 27' "$LOG_DIR/finance.log" || { echo 'Finance result incomplete' >&2; exit 1; }
echo 'Running actual Fleet source payment, lost-HTTP-response, retry and reversal (10 checks)...'
FLEET_QA_PG_SOCKET="$SOCKET_DIR" FLEET_QA_DEPENDENCIES="$DEPS" FLEET_QA_FINANCE_REPO="$FINANCE_REPO" \
  node "$FLEET_REPO/scripts/test-fleet-cash-payment-recovery-postgres.mjs" > "$LOG_DIR/fleet.log" 2>&1 || { tail -35 "$LOG_DIR/fleet.log"; exit 1; }
grep -q '"testsPassed": 10' "$LOG_DIR/fleet.log" || { echo 'Fleet result incomplete' >&2; exit 1; }
printf 'PASS isolated Finance 27/27 + Fleet 10/10; source company 1 -> Finance company 3.\n'
printf 'Coverage: outstanding reduction once; response lost after COMMIT; retry; cancellation and restoration.\n'
printf 'Not covered: browser click with live Google session; live shared-DEV posting.\n'
