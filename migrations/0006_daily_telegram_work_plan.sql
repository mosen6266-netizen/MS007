-- Daily Telegram work-plan module.
-- Independent admin page/schedule; reuses the existing encrypted Telegram Bot Token and reliable queue.

CREATE TABLE IF NOT EXISTS daily_plan_settings (
  sales_user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  send_time_beijing TEXT NOT NULL DEFAULT '09:00',
  chat_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (sales_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_plan_settings_due
ON daily_plan_settings(enabled,send_time_beijing,sales_user_id);

CREATE TABLE IF NOT EXISTS daily_plan_runs (
  sales_user_id TEXT NOT NULL,
  plan_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','retry','success','empty','needs_admin','failed')),
  chat_id TEXT NOT NULL DEFAULT '',
  customer_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT,
  updated_at TEXT NOT NULL,
  error_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (sales_user_id,plan_date),
  FOREIGN KEY (sales_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_plan_runs_date_status
ON daily_plan_runs(plan_date,status,updated_at);

INSERT OR IGNORE INTO sidebar_items
(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at)
VALUES
('sa_daily_plan','admin','每日工作计划','calendar','#/admin/daily-plan','same',1,76,'通知',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO sidebar_item_categories(item_id,audience,category_id)
SELECT 'sa_daily_plan','admin',id
FROM sidebar_categories
WHERE audience='admin' AND label='通知'
LIMIT 1;

INSERT INTO system_settings(setting_key,value_json,updated_at)
VALUES('sidebar_version','1',datetime('now'))
ON CONFLICT(setting_key) DO UPDATE SET
  value_json=CAST(COALESCE(CAST(system_settings.value_json AS INTEGER),0)+1 AS TEXT),
  updated_at=excluded.updated_at;
