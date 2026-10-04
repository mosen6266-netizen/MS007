CREATE TABLE IF NOT EXISTS telegram_progress_notifications (
  progress_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (progress_id) REFERENCES progress_definitions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_progress_notifications_enabled
ON telegram_progress_notifications(enabled,progress_id);

INSERT OR IGNORE INTO telegram_progress_notifications(progress_id,enabled,updated_at)
SELECT id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM progress_definitions
WHERE enabled=1;
