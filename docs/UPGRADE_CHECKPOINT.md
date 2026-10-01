# MS007 Upgrade Checkpoint

Last updated: 2026-10-01

Repository: mosen6266-netizen/MS007
Production Worker: ms007-crm
Production D1: ms007-crm

## Current status

Agreed seven-batch hardening plan is documented in docs/UPGRADE_PLAN.md.

Batch 0 is IN PROGRESS.

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

Do not start Batch 1 until the latest Batch 0 staging and production workflows are confirmed successful.

## Resume instruction for a new chat

"Continue MS007 seven-batch upgrade plan from docs/UPGRADE_PLAN.md and docs/UPGRADE_CHECKPOINT.md. Verify the latest GitHub commit and workflow status first, then continue from the last completed checkpoint without repeating or resetting existing production data."
