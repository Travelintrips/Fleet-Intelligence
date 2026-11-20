# Gojek rental accounting → PT Diva Servis (Company 3): DEV acceptance

Status: **QA mapping and PostgreSQL rollback proof only; NO PROD GL posting authorization**.

## Existing custody

- Gojek / GoPartner raw and normalized rental events remain Fleet **Company 1**, read from public.fleet_transactions and mapped to Finance **Company 3**.
- Existing dedicated private Fleet cash-payment receiver was verified separately through HTTP (original QA journal #684, reversal #685). It is **not** an automatic rental-event posting writer.
- Existing Gojek CSV scheduler, WA jobs, bank reconciliation, Fleet driver balances and Diva vehicle assets are outside the scope of this mapping.
- `Rental fee deduction` is a Gojek platform offset against a driver liability/receivable; **do not debit Cash/Bank** solely because a CSV deduction exists. Clearing against platform must be reconciled using suitable settlement evidence later.
- Rebate proposal assumes it reduces the driver rental receivable; Finance must verify contractual treatment and open driver credit/refund handling before PROD accounting approval. PPN/tax treatment cannot be inferred from the CSV.

## Created in real CST-DEV, company 3 (20 Nov 2026)

| COA code | DEV ID | Normal balance | Role |
|---|---:|---|---|
| 1-1025-DV | 75835 | Debit | Gojek deduction clearing |
| 1-1035-DV | 75836 | Debit | Dedicated driver vehicle-rental receivable |
| 4-1026-DV | 75837 | Credit | Dedicated Gojek vehicle-rental revenue |
| 4-1027-DV | 75838 | Debit | Rebate contra-revenue |

The four COAs are DEV only and active/postable for QA; `approved_by` remains NULL. No tenant-rental, freight, or CST-company account was reused. There is **no approved PROD account map**.

## Actual CST-DEV PostgreSQL QA results

Real source rows `public.fleet_transactions`:
- id **3**, report **2**, 2026-11-04, `Rental fee due`, +Rp5,000, Company1.
- id **2**, report **2**, 2026-11-04, `Rental fee deduction`, -Rp5,000, same driver/company.

A real PostgreSQL transaction inserted temporary headers and debit/credit lines into canonical `public.accounting_entries` / `accounting_entry_lines`, using Company3 journal `GEN-DV` id21 and the new Company3 COAs. Both headers were posted *inside the rollback transaction*, making four journal lines and four derived ledger rows. Debit=credit **Rp10,000**, driver rental receivable net zero, Gojek clearing debit Rp5,000, vehicle rental revenue credit Rp5,000.

Replaying an identical header was idempotent; trying to INSERT lines again after posting was **correctly blocked** by PostgreSQL `IMMUTABILITY_VIOLATION`. Replays must validate immutable existing headers/lines/ledger, not attempt to mutate them.

An independent **synthetic** rebate of -Rp200 (there is no rebate in the available DEV source dataset) produced a journal with debit contra revenue Rp200 and credit driver receivable Rp200, two accounting lines and two derived ledger rows, variance zero. This is QA of the proposed accounting representation, not a real Gojek rebate E2E.

All tests used `BEGIN ... ROLLBACK`; a subsequent separate read returned **zero** QA accounting headers, lines, and ledger rows. Four persisted DEV COA records remain. No bank or PROD mutations.

## Additional controls and remaining GO gates

1. One Super Admin/Finance authority must approve account ownership, revenue recognition timing/contract, Gojek clearing mechanics, rebate receivable vs refund handling, and PPN treatment. Incomplete or unknown source event type remains NO-GO.
2. Source events need immutable Company1 transaction ID + report ID + original type/amount/date; use deterministic `gojek-rental:1:<transactionId>` key; absent provider reference is allowed but never invented. Reject conflicting replay.
3. Introduce canonical Company3 GL source enumeration and source event uniqueness only in a reviewed DEV migration, with complete tests for concurrency, period lock, idempotent replay, reversal, ledger side effects and forced failure rollback. Do **not** use `source='manual'` as a PROD shortcut; it was only used for rollback QA because the current enum lacks a dedicated Gojek rental source.
4. Keep `CENTRAL_FINANCE_WRITE_ENABLED=false` in PROD and the new planner `postingAllowed:false` regardless of unit-test PASS.
5. After all above pass in DEV, independently verify BizPortal Company3 accounting reports, driver outstanding treatment, source/ledger parity and authorized service identity before a controlled PROD release.

Evidence tracked at Fleet Issue #128 and this PR.
