-- MS007 migration baseline.
-- This is intentionally non-destructive. Cloudflare D1 tracks this file in its
-- d1_migrations table so every later migration is applied at most once.
CREATE TABLE IF NOT EXISTS ms007_migration_guard (
  guard_key TEXT PRIMARY KEY,
  guard_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO ms007_migration_guard(guard_key,guard_value,updated_at)
VALUES('migration_system','enabled',datetime('now'));
