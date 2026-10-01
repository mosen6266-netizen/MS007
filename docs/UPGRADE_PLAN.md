# MS007 Upgrade Plan

This file is the persistent handoff for the agreed MS007 hardening project.

## Non-negotiable safety rules

- Never delete, reset, recreate, or silently modify existing customer records, customer field values, progress completion records, completion timestamps, owners, archived/deleted state, dashboard settings, registration fields, registration layout, customer-list settings, sidebar settings, or Telegram configuration during a normal software upgrade.
- Existing production data is authoritative. New derived data such as search indexes may be rebuilt from it, but must never become the source of truth for customer records.
- Database evolution must be forward-compatible: add -> backfill -> verify -> switch. Do not delete old data first.
- Every batch must go through validation, staging, production deployment, and production smoke checks before the next batch begins.
- Avoid broad refactors while changing business/data behavior. CSS/module cleanup is intentionally last.
- Production database changes use versioned one-time D1 migrations, not repeated application of bootstrap schema.
- Record a D1 Time Travel recovery point before production migrations.

## Seven agreed batches

### Batch 0 - Safety foundation
- One-time D1 migration system.
- Fresh-database schema is bootstrap-only.
- Stop deleted defaults from being recreated on later deploys.
- Legacy sidebar group migration runs only as bootstrap/one-time migration behavior.
- Staging environment before production.
- Production recovery-point recording.
- Version/commit display.
- Stronger database safety checks.

### Batch 1 - First-priority data correctness
- Fix account pagination vs owner selectors (all salespeople must remain selectable).
- Atomic customer + progress save.
- Optimistic concurrency/version conflict detection.
- Server-side required/type/select/owner validation.
- Correct handling of inactive salespeople who still own customers.
- Eliminate progress-definition reappearance/cache inconsistencies.

### Batch 2 - Referential consistency and audit detail
- Progress/dashboard reference handling.
- Stable Telegram custom-field variable identity.
- Transactional permanent field deletion and complete reference cleanup.
- Select-option impact analysis before removal/change.
- Audit records show before -> after changes.

### Batch 3 - Backup/restore V3
- Versioned manifest, record counts, checksums.
- Restore dry-run/preview and conflict report.
- Chunked import/export suitable for large datasets.
- Include Telegram non-secret settings/routes and admin account metadata.
- Never store plaintext passwords or Bot Token in backup.
- Safer UPSERT behavior instead of destructive REPLACE semantics.

### Batch 4 - Performance
- One-row-per-customer search index for name, case number, phone, email, and every enabled searchable field.
- Incremental search-index synchronization.
- Background batched progress recalculation with visible admin status.
- Capacity snapshot cache every 30-60 minutes.
- Cursor pagination for audit, recycle bin, and Telegram history.

### Batch 5 - Draft and Telegram reliability
- Draft expiration after 7 days.
- Remove expired drafts for the current account on logout.
- Telegram queue monitor: pending/retry counts, oldest wait, recent success rate.
- Manual retry.
- Dead-letter / "需要管理员处理" state after repeated unrecoverable attempts.
- Continue favoring no lost notifications over the tiny unavoidable duplicate-delivery edge case.

### Batch 6 - Testing, deployment, and code/CSS governance
- Business regression tests: authorization, customers, progress, delete/restore, field/progress definitions, backup/restore, sidebar categories, Telegram queue, account pagination.
- Staging -> tests -> production deployment gate.
- Version visibility and rollback procedure.
- Incremental module split of large app.js/worker.js.
- Consolidate duplicate responsive/customer CSS only after behavior is protected by tests.

## Cost principle

Implement with existing GitHub/Cloudflare capabilities first. No new paid service is required merely to perform these upgrades. Upgrade Cloudflare only if real usage later exceeds plan limits.
