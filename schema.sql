PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  role TEXT NOT NULL CHECK (role IN ('admin','sales')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  assigned_user_id TEXT,
  name TEXT NOT NULL,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_percent INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_user_id) REFERENCES users(id),
  FOREIGN KEY (created_by_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_customers_assigned ON customers(assigned_user_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_customers_archived ON customers(archived, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS field_definitions (
  id TEXT PRIMARY KEY,
  field_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  required INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  list_visible INTEGER NOT NULL DEFAULT 0,
  list_sort_order INTEGER NOT NULL DEFAULT 100,
  sort_order INTEGER NOT NULL DEFAULT 100,
  options_json TEXT NOT NULL DEFAULT '[]',
  searchable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fields_sort ON field_definitions(enabled, sort_order);

CREATE TABLE IF NOT EXISTS customer_values (
  customer_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, field_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (field_id) REFERENCES field_definitions(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_values_field ON customer_values(field_id, value);
CREATE INDEX IF NOT EXISTS idx_customer_values_customer ON customer_values(customer_id);

CREATE TABLE IF NOT EXISTS progress_definitions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  color TEXT NOT NULL DEFAULT '#2563eb',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_defs_sort ON progress_definitions(enabled, sort_order);

CREATE TABLE IF NOT EXISTS customer_progress (
  customer_id TEXT NOT NULL,
  progress_id TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_by TEXT,
  completed_at TEXT,
  PRIMARY KEY (customer_id, progress_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (progress_id) REFERENCES progress_definitions(id),
  FOREIGN KEY (completed_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_progress_customer ON customer_progress(customer_id, completed);

CREATE TABLE IF NOT EXISTS sidebar_items (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('admin','sales','all')),
  label TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'circle',
  url TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'same' CHECK (target IN ('same','new')),
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  group_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sidebar_audience ON sidebar_items(audience, enabled, sort_order);

CREATE TABLE IF NOT EXISTS list_columns (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('admin','sales')),
  column_key TEXT NOT NULL,
  field_id TEXT,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  FOREIGN KEY (field_id) REFERENCES field_definitions(id)
);
CREATE INDEX IF NOT EXISTS idx_list_columns ON list_columns(audience, enabled, sort_order);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('admin','sales')),
  widget_type TEXT NOT NULL,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO progress_definitions
(id,label,description,enabled,sort_order,color,created_at,updated_at) VALUES
('p_registered','已登记','客户基础信息已登记',1,10,'#ef4444',datetime('now'),datetime('now')),
('p_contacted','已联系','已完成首次联系',1,20,'#f97316',datetime('now'),datetime('now')),
('p_materials','资料收集','主要资料已收集',1,30,'#eab308',datetime('now'),datetime('now')),
('p_review','资料审核','资料已完成审核',1,40,'#3b82f6',datetime('now'),datetime('now')),
('p_processing','处理中','进入正式处理阶段',1,50,'#8b5cf6',datetime('now'),datetime('now')),
('p_completed','已完成','客户流程全部完成',1,60,'#22c55e',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO field_definitions
(id,field_key,label,field_type,required,enabled,list_visible,list_sort_order,sort_order,options_json,searchable,created_at,updated_at) VALUES
('f_phone','phone','手机号','phone',0,1,1,20,20,'[]',1,datetime('now'),datetime('now')),
('f_email','email','邮箱','email',0,1,1,30,30,'[]',1,datetime('now'),datetime('now')),
('f_country','country','国家/地区','text',0,1,1,40,40,'[]',1,datetime('now'),datetime('now')),
('f_city','city','城市','text',0,1,0,50,50,'[]',1,datetime('now'),datetime('now')),
('f_case_no','case_no','案件编号','text',0,1,1,10,10,'[]',1,datetime('now'),datetime('now')),
('f_notes','notes','备注','textarea',0,1,0,100,100,'[]',1,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO sidebar_items
(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at) VALUES
('sa_dashboard','admin','仪表盘','layout-dashboard','#/admin/dashboard','same',1,10,'',datetime('now'),datetime('now')),
('sa_customers','admin','全部客户','users','#/admin/customers','same',1,20,'',datetime('now'),datetime('now')),
('sa_sales','admin','业务员管理','user-cog','#/admin/sales','same',1,30,'管理',datetime('now'),datetime('now')),
('sa_fields','admin','登记字段','list-plus','#/admin/fields','same',1,40,'管理',datetime('now'),datetime('now')),
('sa_progress','admin','客户进度','check-circle','#/admin/progress','same',1,50,'管理',datetime('now'),datetime('now')),
('sa_sidebar','admin','左侧栏管理','panel-left','#/admin/sidebar','same',1,60,'管理',datetime('now'),datetime('now')),
('sa_capacity','admin','系统容量与费用','database','#/admin/capacity','same',1,70,'系统',datetime('now'),datetime('now')),
('ss_dashboard','sales','仪表盘','layout-dashboard','#/sales/dashboard','same',1,10,'',datetime('now'),datetime('now')),
('ss_customers','sales','我的客户','users','#/sales/customers','same',1,20,'',datetime('now'),datetime('now')),
('ss_new','sales','登记客户','user-plus','#/sales/new','same',1,30,'',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO list_columns
(id,audience,column_key,field_id,label,enabled,sort_order) VALUES
('lca_name','admin','name',NULL,'客户姓名',1,10),
('lca_owner','admin','owner',NULL,'业务员',1,20),
('lca_case','admin','dynamic','f_case_no','案件编号',1,30),
('lca_country','admin','dynamic','f_country','国家/地区',1,40),
('lcs_name','sales','name',NULL,'客户姓名',1,10),
('lcs_case','sales','dynamic','f_case_no','案件编号',1,20),
('lcs_country','sales','dynamic','f_country','国家/地区',1,30);

INSERT OR IGNORE INTO dashboard_widgets
(id,audience,widget_type,title,enabled,sort_order,config_json) VALUES
('dwa_total','admin','metric_total','客户总数',1,10,'{}'),
('dwa_today','admin','metric_today','今日新增',1,20,'{}'),
('dwa_complete','admin','metric_complete','已完成',1,30,'{}'),
('dwa_sales','admin','sales_breakdown','业务员客户分布',1,40,'{}'),
('dws_total','sales','metric_total','我的客户',1,10,'{}'),
('dws_today','sales','metric_today','今日新增',1,20,'{}'),
('dws_complete','sales','metric_complete','已完成',1,30,'{}');

INSERT OR IGNORE INTO system_settings(setting_key,value_json,updated_at) VALUES
('capacity_config','{"provider":"Cloudflare","database":"D1","free_single_db_mb":500,"free_account_gb":5,"free_rows_read_day":5000000,"free_rows_write_day":100000,"free_worker_requests_day":100000,"paid_base_usd_month":5,"warning_percent":70,"upgrade_percent":85,"urgent_percent":95,"upgrade_url":"https://dash.cloudflare.com/","pricing_checked":"2026-10-01"}',datetime('now'));


INSERT OR IGNORE INTO sidebar_items
(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at) VALUES
('sa_listsettings','admin','客户列表设置','list-plus','#/admin/list-settings','same',1,55,'管理',datetime('now'),datetime('now')),
('sa_dashsettings','admin','仪表盘设置','layout-dashboard','#/admin/dashboard-settings','same',1,65,'管理',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO system_settings(setting_key,value_json,updated_at)
VALUES('sidebar_version','1',datetime('now'));


INSERT OR IGNORE INTO sidebar_items
(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at) VALUES
('sa_audit','admin','操作记录','list-plus','#/admin/audit','same',1,80,'系统',datetime('now'),datetime('now')),
('sa_recycle','admin','回收站','database','#/admin/recycle','same',1,90,'系统',datetime('now'),datetime('now')),
('sa_backup','admin','数据备份','database','#/admin/backup','same',1,100,'系统',datetime('now'),datetime('now'));


INSERT OR IGNORE INTO sidebar_items
(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at) VALUES
('sa_reglayout','admin','登记面板设置','list-plus','#/admin/registration-layout','same',1,58,'管理',datetime('now'),datetime('now'));


CREATE TABLE IF NOT EXISTS telegram_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT NOT NULL DEFAULT '',
  bot_token_enc TEXT NOT NULL DEFAULT '',
  bot_token_hint TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '[{"key":"sales_name","label":"业务员"},{"key":"customer_name","label":"客户姓名"},{"key":"completed_progress","label":"已完成进度"},{"key":"next_progress","label":"下一步进度"},{"key":"progress_percent","label":"当前完成度"}]',
  notify_admin INTEGER NOT NULL DEFAULT 0,
  link_label TEXT NOT NULL DEFAULT '查看客户详情',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO telegram_settings
(id,enabled,chat_id,bot_token_enc,bot_token_hint,fields_json,notify_admin,link_label,updated_at)
VALUES
(1,0,'','','','[{"key":"sales_name","label":"业务员"},{"key":"customer_name","label":"客户姓名"},{"key":"completed_progress","label":"已完成进度"},{"key":"next_progress","label":"下一步进度"},{"key":"progress_percent","label":"当前完成度"}]',0,'查看客户详情',datetime('now'));

CREATE TABLE IF NOT EXISTS telegram_progress_routes (
  progress_id TEXT PRIMARY KEY,
  route_mode TEXT NOT NULL CHECK (route_mode IN ('replace','additional')),
  chat_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (progress_id) REFERENCES progress_definitions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telegram_progress_routes_mode
ON telegram_progress_routes(route_mode);

CREATE TABLE IF NOT EXISTS telegram_delivery_logs (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  actor_user_id TEXT,
  progress_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_delivery_created ON telegram_delivery_logs(created_at DESC);

INSERT OR IGNORE INTO sidebar_items
(id,audience,label,icon,url,target,enabled,sort_order,group_label,created_at,updated_at) VALUES
('sa_telegram','admin','Telegram 通知','link','#/admin/telegram','same',1,75,'通知',datetime('now'),datetime('now'));


CREATE INDEX IF NOT EXISTS idx_customer_progress_progress_completed
ON customer_progress(progress_id, completed, completed_at);
