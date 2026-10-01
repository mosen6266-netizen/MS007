-- Add an optimistic-edit version to customer records and an index for complete salesperson selectors.
ALTER TABLE customers ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_users_role_active_display
ON users(role, active, display_name, id);
