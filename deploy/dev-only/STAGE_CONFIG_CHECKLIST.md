# Fleet DEV isolated staging — configuration and release gates

Use only the dedicated /opt/fleet-intelligence-dev candidate. Do not use Fleet PROD, the public Fleet DEV canary, or a signed-in browser as sources for credentials.

## Authorized setup, not yet complete

1. Provision six secrets in the GitHub Actions fleet-dev environment through the authorized secret manager: HOSTINGER_SSH_HOST, HOSTINGER_SSH_PORT, HOSTINGER_SSH_USER, HOSTINGER_SSH_PRIVATE_KEY, HOSTINGER_SSH_KNOWN_HOSTS, and FLEET_DEV_DEPLOY_PATH (exactly /opt/fleet-intelligence-dev).
2. Independently provision a private /opt/fleet-intelligence-dev/deploy/.env.dev owned by the authorized deploy user, mode 0600. Never commit this file or copy it from Fleet PROD or the active public DEV canary.
3. Required configuration: APP_ENV=development; APP_BASE_URL=https://dev-fleet.cstlogistic.co.id; a dedicated SESSION_SECRET; FLEET_DEV_GOOGLE_AUTH_ENABLED=true; real CST-DEV FLEET_DEV_SUPABASE_PUBLISHABLE_KEY; the authorized FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID and FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID.
4. SUPABASE_DATABASE_URL_DEV must use project xssrfshdrtdfupgqwfdw, exact SELECT-only reader fleet_dev_cst_inventory_reader, PostgreSQL database postgres and sslmode=require; never use a PROD or writer credential.
5. DISABLE_BACKGROUND_SCHEDULERS=true; CENTRAL_FINANCE_WRITE_ENABLED=false; GOJEK_CONNECTOR_ENABLED=false. Docker Compose additionally forces these protective values.

Before stage-dev, run:

    python3 /opt/fleet-intelligence-dev/deploy/dev-only/check-stage-config.py /opt/fleet-intelligence-dev/deploy/.env.dev

The preflight checks file privacy, environment safety, URL/role structure and Google config without printing secret values or connecting to the database. A successful preflight is not proof of working credentials, session, or company isolation.

## Release acceptance

- validate-only runs the new guard tests with synthetic configuration. stage-dev requires real private DEV credentials and starts isolated Docker Compose on 127.0.0.1:18460. Neither mode changes public Nginx.
- After a legitimate candidate exists, verify Google Super Admin signed-in GET Vehicles/Transactions, company isolation, HTTP 401 anonymous, all 413 eligible rows for 1–4 Nov 2026, 400/413 Next/Prev boundaries and full filtered CSV.
- Only then evaluate a controlled Fleet DEV Nginx cutover with preserved PR110 and rollback. Never replay old CSV or change PROD, Gojek worker, WA, Finance or journals.
- If any prerequisite fails, leave public Fleet DEV unchanged and Issue #111 open.
