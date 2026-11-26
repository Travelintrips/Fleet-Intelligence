# PT Diva Servis asset registration

## Behavior

The Fleet Vehicles page's **Tambah Aset Diva** form creates an owned, registered
asset for PT Diva Servis (Company 3). Required identity fields are plate, brand,
model, chassis/VIN, and engine number. The default vehicle type is `car`.
Year, color, fuel/energy, notes, and annual-tax information are supported.
An unknown tax record is explicit (`unrecorded`, both dates empty).

The authenticated `POST /api/logistics/fleet/vehicles/diva-assets` endpoint uses
the existing dedicated Diva editor connection. It fixes Company 3, `own`, and
`registered` on the server. It atomically inserts the unit, annual-tax document,
and creation audit. Duplicate normalized plate, chassis, or engine returns HTTP
409. The UI refreshes the Diva asset registry after a successful save.

The generic operational vehicle endpoint is retained for existing integrations.
The form does not call it. No Gojek history, driver, operational vehicle, bank,
or journal records are created by asset registration.

## Database and deployment

Target: `fleet.cstlogistic.co.id`; Supabase `nzdweipzckfszczzqtuw`.

1. Run typecheck, application tests, `npm run test:diva-db`, and production build.
   The SQL verification uses disposable in-memory PostgreSQL and accepts no
   database URL. It never writes to hosted DEV or PROD.
2. Apply `prod-diva-asset-create-20261126.sql` to the target after verification.
   It grants only the required asset/tax INSERT columns to the existing Diva
   editor, permits the reader and editor to see Company-3 owned assets, enforces
   Company-3 normalized identity uniqueness, and validates audit relationships.
   It does not create roles, change passwords, or modify existing business rows.
3. Deploy the tested code through Fleet's existing Hostinger pipeline. The form
   stays disabled unless the existing writer flags, connection, scoped INSERT
   grants, sequence access, and normalized plate unique index are available.
   No additional credential or environment variable is needed.
4. Verify the exact deployed commit, application readiness, authenticated asset
   form and refreshed registry. Preserve baseline integration behavior.

Tax editing now checks actual owned Company-3 records instead of a fixed list of
three plates. Preflight checks registry ownership and tax linkage, allowing new
assets and renewed dates while retaining the four existing vehicle identities.

## Rollback

Revert the code deployment to the prior Fleet release to remove the new form.
Existing assets and their audit history should be retained. If creation must be
disabled at database level, revoke the newly added unit/document INSERT columns
from `fleet_diva_tax_editor_login_prod`; capability detection will disable the
form. Do not delete vehicle, tax, or audit records as a release rollback.
The additive read scope and unique indexes can remain to preserve registered
assets and duplicate protection.
