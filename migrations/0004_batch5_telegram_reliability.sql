-- Batch 5 Telegram reliability.
-- Preserve the existing queue and all queued messages; only add dead-letter metadata.
ALTER TABLE telegram_send_queue ADD COLUMN requires_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_send_queue ADD COLUMN dead_lettered_at TEXT;

CREATE INDEX IF NOT EXISTS idx_telegram_queue_admin_attention
ON telegram_send_queue(requires_admin, status, created_at);
