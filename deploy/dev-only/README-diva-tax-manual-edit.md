# PT Diva Servis Fleet annual-tax manual editor — DEV only

This extends the existing Fleet Vehicles `Aset PT Diva Servis` panel. It is **NOT** a new finance or GoCar module.

## Operational boundary

- Scope: `B1649PNV`, `B1650PNV`, `B1926PDT`, company 3, `annual_vehicle_tax` only.
- Access: signed Google Fleet DEV Owner/Super Admin, source company 1; exact HTTPS host and Origin required.
- Writer: dedicated Supabase CST-DEV `fleet_diva_tax_editor_login_dev` with strict TLS/hostname and a private optional environment file. Never use the Fleet inventory reader or the Finance writer for edits.
- DB RLS: both restrictive and permissive policies scope updates to company 3 and only fleet-unit IDs 2, 3, 4. UPDATE grant is column-limited: paid date, due date, status, notes and timestamp. Documents/identifiers/files, driver, GoCar transactions, payment and ledger remain inaccessible.
- Every edit commits the document update plus append-only `fleet_tax_edit_audit_dev` row in one transaction.
- `version` (document updated_at) prevents overwriting stale changes.
- Dates can be NULL while unverified. A paid-but-due-unknown status cannot have a fabricated next due date.
- No automatic tax notification, accounting journal, or monetary payment is generated.

## Release gate

1. Apply `deploy/dev-only/diva-tax-manual-editor-20261118.sql` to **CST-DEV project xssrfshdrtdfupgqwfdw only**. It creates the narrow login with **NULL password** (cannot authenticate until separately provisioned), RLS policies and audit table.
2. Provision a fresh SCRAM password for that exact role through authorized Supabase administration, and store the DSN ONLY on the authorized DEV VPS at `/etc/fleet-diva-tax-dev/runtime.env` (mode 0600, parent 0700). Never put the secret in git, CI logs, chat or the browser:
   - `FLEET_DIVA_TAX_EDIT_ENABLED_DEV=true`
   - `FLEET_DIVA_TAX_DATABASE_URL_DEV=postgresql://fleet_diva_tax_editor_login_dev.xssrfshdrtdfupgqwfdw:<private-password>@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full`
3. The DEV Compose reads this file using optional `env_file`. When absent, the API returns `taxEditEnabled:false`; the button is disabled and PATCH rejects. No credential fallback is permitted.
4. Run full Fleet API/web CI and stage **only** the pinned Fleet DEV branch using the existing exact SHA Docker image workflow. Do not touch PROD.
5. Add an **exact PATCH-only** rule on public `dev-fleet.cstlogistic.co.id` Nginx for `^/api/logistics/fleet/vehicles/diva-assets/(B1649PNV|B1650PNV|B1926PDT)/tax$`, proxying to the existing Fleet DEV stage with forwarded cookie, Origin and HTTPS host. Keep a rollback backup. The internal Nginx rule is in source control.
6. Verify anonymous GET=401, wrong-method PATCH route=403, missing/wrong Origin=403, normal vehicles GET unchanged, only the approved owner edit succeeds, stale version=409, and exactly one new audit record. Verify all 48 Company-1 outstanding rows preserve their full-row hash. Confirm new due date on screen after reload.

## Current baseline (18 Nov 2026)

- B1649PNV/B1650PNV: old due 11 Nov 2026, owner-reported paid 17 Nov 2026 (6 days late), next due **not yet verified**.
- B1926PDT: due 30 Dec 2026, not yet renewed.
- User-provided STNK images support the prior due dates but do not establish the next renewed due date.
- The independent read-only asset panel and Fleet→Finance integration are already PASS. Preserve them.

**No merge or activation is a substitute for an authenticated manual browser acceptance.**
