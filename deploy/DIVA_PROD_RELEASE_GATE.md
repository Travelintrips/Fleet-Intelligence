# Fleet PROD release candidate — PT Diva Servis Wuling Cloud assets

**This PR is a candidate, not a production deployment.** It applies only the existing DEV-approved asset registry and tax UI to Fleet `main`; it does not merge the DEV stabilization branch.

## Baselines

- Target: native Hostinger Fleet PROD `fleet.cstlogistic.co.id`; deployed main SHA at review: `69a988fd071bc8706bd680aa3bb7415b7e93061f`.
- PROD Supabase project: `nzdweipzckfszczzqtuw`, not the CST-DEV Supabase project.
- PROD Gojek/WA/Finance integration health baseline before any release: `/healthz=200`, `/api/readyz=200` with 24 dependencies; WA gateway/device online; Finance writer remains OFF.
- PROD currently has neither the three assets in `fleet_units` nor their annual tax records.
- Existing DEV owner confirmation: B1649PNV/B1650PNV paid 17 Nov 2026 (six days after previous due 11 Nov 2026), new expiry **11 Nov 2027 verified in owner-provided renewal photos**, B1926PDT due 30 Dec 2026 and not renewed. The user recently supplied additional photographed renewal evidence; do not enter a new expiry until the photo's 11 Nov 2027 date is included.

## PROD-only isolation

- Read/write flags **OFF by default**, configured separately:
  - `FLEET_DIVA_ASSET_READ_ENABLED_PROD=false`
  - `FLEET_DIVA_TAX_EDIT_ENABLED_PROD=false`
  - `FLEET_DIVA_ASSET_DATABASE_URL_PROD`
  - `FLEET_DIVA_TAX_DATABASE_URL_PROD`
- Credentials must be unique PROD-only roles for `nzdweipzckfszczzqtuw`: `fleet_diva_asset_reader_login_prod` and `fleet_diva_tax_editor_login_prod`. TLS `verify-full` and pinned Supabase CA. Never reuse DEV credentials or grant writer permission to the existing Fleet runtime.
- Reader and editor use separate pools. Only 3 Diva unit identities are permitted, and writer is restricted to tax columns and append-only tax audit.
- Feature handlers reuse the current PROD Fleet login and its signed session, require Owner or Super Admin, company 1 session, verified HTTPS fleet.cstlogistic.co.id Origin on edit, and refuse anonymous requests.
- No changes to Gojek connector, scheduler, WA, central Finance or Company-1 operational data.

## Gates before any PROD DB or merge

1. **Finish actual DEV authenticated E2E**: update unchanged B1649PNV tax details with a QA note, verify exactly one audit row; test stale-version 409 and unauthenticated 401, malformed 400; prove outstanding/import/transactions unchanged. Current audit rows were 0 on latest DEV check.
2. Verify photographed renewed STNK/PKB plates and the 11 Nov 2027 annual due date for B1649/B1650 in the QA audit.
3. Take safe PROD baseline snapshots of fleet_units, documents, driver/transaction and worker job counts; guarantee no destructive or cross-company modifications.
4. Review `deploy/prod-diva-asset-release-20261118.sql` in isolation. Its offline PostgreSQL 16 execution passed: 3 asset rows, 3 annual tax rows, 2 dedicated password-NULL roles. **Not yet executed on PROD**.
5. Provision fresh PROD-only SCRAM secrets through approved secure mechanism; never put them in GitHub, chat or logs. Re-run RLS tests and deny GoCar/finance writes.
6. Run full CI and isolated release smoke; keep all feature flags OFF. **Only after all pass**, merge this narrow PR into `main`, deploy using Hostinger's real production pipeline, and confirm exact SHA.
7. First activate read-only feature, verify signed production dashboard and 3 assets, cross-company isolation, Gojek sync heartbeat. Then activate editor only after signed admin SAVE/AUDIT acceptance and planned rollback.
8. Confirm all background jobs, Gojek/GoPartner sync, WA send and Finance readiness retain their baseline. Maintain a prepared rollback for Hostinger code, PROD scoped roles and the feature flags.

**Never release the entire DEV stabilization branch to main. This candidate's CI/isolated SQL PASS alone is insufficient for deployment.**
