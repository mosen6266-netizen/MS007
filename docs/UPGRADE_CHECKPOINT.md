# MS007 Upgrade Checkpoint

Last updated: 2026-10-01

Repository: mosen6266-netizen/MS007
Production Worker: ms007-crm
Production D1: ms007-crm

## Current status

Agreed seven-batch hardening plan is documented in docs/UPGRADE_PLAN.md.

Batch 0 is COMPLETE.

Batch 1 is COMPLETE.

Batch 2 is COMPLETE.

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


## Batch 2 completed verification

Final verified commit: c8a0ebc4111c8f3d14451afb6d8e3b23c2fee0a8

Implemented:
- Progress disable automatically hides dashboard widgets that depend on that progress.
- Permanent progress deletion atomically cleans progress records, Telegram routing/queue references, and dependent dashboard widgets before recalculation.
- Telegram custom registration-field variables now use stable field-ID tokens while preserving legacy token compatibility; field rename no longer breaks saved templates.
- Permanent field deletion cleans customer values, customer-list references, registration layout, Telegram selected fields, and Telegram template references in one D1 batch.
- Select-option impact preflight prevents removing options still used by customer data; admin can safely keep those old options and save other changes without data loss.
- Operation records now surface before/after details for important customer, field, progress, dashboard, user, and Telegram setting changes.
- Added duplicate named-function guard after detecting and removing an obsolete duplicate progress updater.
- Added Batch 2 referential integrity regression tests.

Verification:
- Quality Check run 36920040435: success.
- Deploy run 36920040463: success.
- Validation + Batch 1 + Batch 2 regression checks: success.
- Staging deploy/smoke: success.
- Production recovery point: success.
- Production bootstrap schema: skipped.
- Production migrations: success/no unapplied migrations.
- Production deploy/smoke: success.

Next work: Batch 3 - Backup/Restore V3. (completed below)


## Batch 3 completed verification

Final verified commit: 97267b0d43d498eeff9c0c97116a770d0c8d4354

Implemented:
- Backup V3 manifest with version, record counts, total record count, chunk metadata, and per-section SHA-256 integrity checks.
- Chunked export suitable for larger datasets instead of the old one-request full export path.
- Full restore integrity verification and dry-run/preview across all V3 sections before the first write is allowed.
- Conflict reporting for account identity/role, field keys, and sidebar category identity; conflicts stop restore before any data is written.
- Safe UPSERT/UPDATE restore behavior; destructive REPLACE semantics were removed from the restore path.
- Backup now includes non-secret Telegram settings/routes, administrator/sales account metadata, audit history, and Telegram delivery history.
- Password hashes/salts, login sessions, bootstrap token, and Telegram Bot Token remain excluded from backup and restore.
- New imported accounts remain disabled and require an administrator to set a password before enabling.
- Legacy V2 business backup restore remains supported for backward compatibility, while V3 receives the stronger integrity and preview protections.
- Added Batch 3 Backup/Restore V3 regression checks and made both quality and deployment validation run them.

Verification:
- Quality Check run 36922766798: success.
- Deploy run 36922766823: success.
- Frontend/Worker syntax, database safety gate, duplicate-function guard, Batch 1, Batch 2, and Batch 3 regressions: success.
- Staging database already existed, so bootstrap schema was skipped.
- Staging migrations, deployment, and smoke test: success.
- Production database already existed, so bootstrap schema was skipped.
- Production recovery point was recorded and uploaded before migrations.
- Production migrations applied successfully; no unapplied migrations remained.
- Production deployment and smoke test: success.

Next work: Batch 4 - Performance. (completed below)


## Batch 4 completed verification

Final verified commit: 4050a9fcb2f906ef6e212e8b821f63f993a73b01

Implemented:
- Added one-row-per-customer derived search index for customer name plus enabled searchable fields, with explicit phone/email/case-number coverage.
- Added safe add -> background backfill -> count verification -> switch behavior. Until verification is complete, customer search continues using the authoritative legacy path.
- Added incremental search-index synchronization for customer create/update/atomic save/restore, and full index rebuild scheduling after searchable-field semantics or restored business data changes.
- Replaced synchronous all-customer progress recalculation with a bounded background maintenance job processed by the existing minute cron.
- Added administrator-visible maintenance status to the dashboard/capacity page.
- Added a 45-minute capacity snapshot cache so opening the capacity/dashboard view no longer rescans the large customer/value/audit tables every time.
- Converted audit history, recycle bin, and full Telegram history from OFFSET pagination to stable keyset/cursor pagination.
- Added migration 0003_batch4_performance.sql for derived search-index and maintenance-state tables only; existing customer/progress records remain authoritative.
- Added Batch 4 regression checks and required-table validation to both quality and deployment gates.
- Restored and regression-protected bootstrap/login/logout handlers after staging safely detected an accidental block-removal during the first Batch 4 attempt.

Verification:
- Quality Check run 36924446172: success.
- Deploy run 36924446377: success.
- Frontend/Worker syntax, database safety gate, fresh schema+migrations, Batch 1, Batch 2, Batch 3, and Batch 4 regressions: success.
- Staging migration, deployment, /api/health, and /api/bootstrap-status smoke: success.
- Production recovery point was recorded and uploaded before applying migration 0003.
- Production migration applied successfully and no unapplied migration remained.
- Production deployment and smoke test: success.
- Production database was not bootstrapped/recreated.

Next work: Batch 5 - Draft and Telegram reliability. (completed below)


## Batch 5 completed verification

Final verified commit: 9eedab35ab2363dc640f4c70260590c5bb98a15d

Implemented:
- Local overlay drafts expire after 7 days.
- Expired drafts for the currently logged-in account are cleaned on logout; drafts belonging to other accounts are not touched.
- Added Telegram queue monitor with pending count, retry count, administrator-attention count, oldest active wait, and rolling 24-hour delivery success rate.
- Permanent Telegram errors and repeated automatic failures are retained in the queue as administrator-attention items instead of being deleted.
- Added manual retry after the administrator fixes Telegram token/chat/template/permission issues.
- Automatic processing skips administrator-attention items until manually retried.
- Preserved existing Telegram queue rows in place; migration 0004 only added requires_admin and dead_lettered_at metadata plus an index.
- Added Batch 5 reliability regression checks to both quality and deployment gates.
- Used a pull-request validation branch before merge so Batch 5 was fully checked without touching Cloudflare production.

Verification:
- Pull Request #1 Quality Check run 36927987144: success.
- Main Quality Check run 36928037590: success.
- Main Deploy run 36928037427: success.
- Frontend/Worker syntax, database destructive-change safety gate, fresh schema+migrations, Batch 1-5 regressions: success.
- Staging migration, deployment and smoke test: success.
- Production recovery point recorded and uploaded before migration.
- Production migration applied successfully; no unapplied migration remained.
- Production deployment and smoke test: success.
- Production database was not bootstrapped/recreated.

Next work: Batch 6.
