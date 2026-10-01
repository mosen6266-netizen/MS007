# MS007 Disaster Recovery

## Source of truth

- Code/configuration source: GitHub repository `mosen6266-netizen/MS007`, branch `main`.
- Production Worker name: `ms007-crm`.
- Production D1 name: `ms007-crm`.
- Customer/business records are authoritative in D1 or in an exported MS007 V3 business backup.
- Search indexes, maintenance state, capacity snapshots, and dashboard statistics cache are derived and may be rebuilt.

## Safety rules

A normal upgrade or code rollback must not delete, reset, recreate, or silently rewrite existing customer records, field values, owners, progress completion records/timestamps, archived/deleted state, field definitions, dashboard/sidebar/registration settings, or Telegram configuration.

For account authorization and required repository settings, follow `docs/DEPLOYMENT.md`. Never place credential values inside repository files.

## GitHub lost, Cloudflare/D1 still exists

1. Create a new GitHub repository and upload the complete MS007 repository, including hidden `.github/` plus `migrations/`, `scripts/`, `tests/`, `public/`, `src/`, `schema.sql`, and `wrangler.toml`.
2. Use `main` as the default branch.
3. Configure the required GitHub Actions authorization settings exactly as described in `docs/DEPLOYMENT.md`.
4. Point deployment at the existing Cloudflare account/database.
5. Do **not** run `schema.sql` against an existing production database. Existing databases advance only through versioned `migrations/`.
6. Run the normal quality/deployment workflow.
7. Confirm `/api/health` shows the expected commit/channel.

## Worker lost, D1 still exists

Re-run the normal deployment workflow from `main`. The workflow redeploys Worker/assets and applies only unapplied migrations. Existing D1 customer data is not bootstrapped again.

## Bad migration or bad release

Use the production D1 Time Travel recovery point recorded by the deployment workflow before production migrations, then redeploy a previously verified commit.

## Entire Cloudflare database/account lost

Code alone cannot recreate customer/business records.

1. Create/connect replacement infrastructure and configure authorization per `docs/DEPLOYMENT.md`.
2. Deploy `main`. A brand-new D1 may use `schema.sql`, then all migrations.
3. Initialize the first administrator only when the system reports an empty user database.
4. Import the latest verified **MS007 V3** business backup through the admin restore flow.
5. Use preview/conflict validation before the first restore write.
6. Reconfigure secrets that are intentionally excluded from portable backups.
7. Allow derived search/progress maintenance jobs to rebuild, then verify counts and dashboard values.

## Batch 7 cache

`dashboard_statistics_cache` is disposable derived data. If unavailable, empty, or corrupt, the Worker falls back to authoritative statistics queries. Customer/progress records never depend on this cache for recovery.

## Final validation checklist

- Quality Check green.
- Deployment validation/staging/production green.
- No unapplied production migrations.
- Production `/api/health` matches the deployed commit.
- Customer list/edit/save/progress/recycle/dashboard/backup preview/import paths remain available.
- Keep a recent portable MS007 V3 business backup outside the Cloudflare account if total-account-loss recovery is required.
