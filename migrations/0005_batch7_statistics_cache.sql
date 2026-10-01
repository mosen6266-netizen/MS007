-- MS007 Batch 7.2 Statistics Cache
-- Adds an isolated cache layer for dashboard statistics.
-- Existing customer/business data is not modified.

CREATE TABLE IF NOT EXISTS dashboard_statistics_cache (
  cache_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_statistics_cache_updated
ON dashboard_statistics_cache(updated_at);
