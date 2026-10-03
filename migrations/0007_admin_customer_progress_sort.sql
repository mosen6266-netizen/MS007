-- Admin 全部客户默认按已完成进度数倒序；为 keyset 分页提供覆盖排序索引。
CREATE INDEX IF NOT EXISTS idx_customers_admin_progress
ON customers(archived, deleted_at, progress_done DESC, updated_at DESC, id DESC);
