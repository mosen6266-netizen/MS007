# MS007 Upgrade Checkpoint

Last updated: 2026-10-01

Repository: mosen6266-netizen/MS007
Production Worker: ms007-crm
Production D1: ms007-crm

## Current status

Agreed seven-batch hardening plan is documented in docs/UPGRADE_PLAN.md.

Batch 0 is COMPLETE.

Batch 1 is COMPLETE.

Changes already committed in Batch 0:
- Added migrations/0000_baseline_migration_system.sql.
- Configured Wrangler migrations directory.
- Added APP_VERSION / DEPLOY_CHANNEL metadata.
- Health endpoint exposes deployment version/channel.
- Sidebar displays deployed version.
- Marked schema.sql as fresh-database bootstrap only.
- Added scripts/check-db-safety.mjs.
- Strengthened quality checks for schema + migrations.
- Added scripts/resolve-d1.mjs and scripts/build-deploy-config.mjs.
- Reworked deployment pipeline to validate -> staging -> production, apply schema only to newly created DBs, use D1 migrations for existing DBs, and record a Time Travel recovery point before production migrations.

Batch 0 verification:
- Quality Check run 36917222505: success.
- Deploy run 36917222633: success.
- Staging validation: success.
- Production recovery point recorded and uploaded before migration.
- Existing production database was detected, so fresh bootstrap schema was SKIPPED.
- Production D1 migration applied successfully.
- No unapplied migrations remained.
- Production deployment and smoke test succeeded.
- Production code version deployed: 14663efc44bc.

Next work: Batch 1 - first-priority data correctness.

## Resume instruction for a new chat

"Continue MS007 seven-batch upgrade plan from docs/UPGRADE_PLAN.md and docs/UPGRADE_CHECKPOINT.md. Verify the latest GitHub commit and workflow status first, then continue from the last completed checkpoint without repeating or resetting existing production data."


## Batch 1 completed verification

Final verified commit: 609bffb0180c674dfb649157f9d77303b8d79793

Implemented:
- Dedicated complete salesperson selector API; account-management pagination no longer truncates customer owner selectors.
- Existing inactive owners remain visible and can be retained; new assignments to inactive accounts are blocked.
- Atomic customer profile + progress save.
- Optimistic edit-version conflict protection prevents stale editors from overwriting newer changes.
- Server-side validation for required fields, supported data types, select options, field existence, and owner validity.
- Dashboard ownership statistics retain inactive salespeople who still own customers.
- One-time repair of derived customer progress totals/percentages without changing completion records or completion timestamps.
- Regression tests for guarded field/progress updates and stale-version protection.

Verification:
- Quality Check run 36918622222: success.
- Deploy run 36918622051: success.
- Validation regression step: success.
- Staging migrations/deploy/smoke: success.
- Production recovery point: success.
- Production migrations: success.
- Production bootstrap schema: skipped because the existing production database was preserved.
- Production deploy/smoke: success.

Next work: Batch 2 - referential consistency and detailed auditing.
