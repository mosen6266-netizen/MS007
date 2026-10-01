-- Batch 4 performance foundation.
-- These are derived structures only. Existing customer/progress records remain authoritative.

CREATE TABLE IF NOT EXISTS customer_search_index (
  customer_id TEXT PRIMARY KEY,
  search_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customer_search_updated
ON customer_search_index(updated_at);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
  task_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','failed')),
  cursor_id TEXT NOT NULL DEFAULT '',
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT OR IGNORE INTO maintenance_jobs(
  task_key,status,cursor_id,processed,total,detail_json,requested_at,started_at,updated_at,completed_at
) VALUES(
  'search_index_rebuild','pending','',0,
  (SELECT COUNT(*) FROM customers WHERE deleted_at IS NULL),
  '{}',datetime('now'),NULL,datetime('now'),NULL
);
