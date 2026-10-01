import pathlib
import re

root=pathlib.Path(__file__).resolve().parents[1]
worker=(root/"src/worker.js").read_text(encoding="utf-8")
app=(root/"public/app.js").read_text(encoding="utf-8")

# Batch 3 API surface must exist.
for token in [
    "BACKUP_V3_SECTIONS",
    "/api/admin/export-manifest",
    "/api/admin/export-section",
    "/api/admin/import-preview-chunk",
]:
    assert token in worker,token

# Backup V3 must include the agreed non-secret configuration/history sections.
for section in [
    "users","customers","fieldDefinitions","customerValues","progressDefinitions","customerProgress",
    "sidebarCategories","sidebarItems","sidebarItemCategories","listColumns","dashboardWidgets",
    "systemSettings","telegramSettings","telegramProgressRoutes","auditLogs","telegramDeliveryLogs",
]:
    assert f'"{section}"' in worker,section

spec=worker[worker.index("function backupSectionSpec"):worker.index("async function exportBackupManifest")]
assert "SELECT id,username,display_name,role,active,created_at,updated_at" in spec
assert "bot_token_enc" not in spec
assert "password_hash" not in spec
assert "password_salt" not in spec
assert "telegram_settings" in spec

# Restore path must use UPSERT/UPDATE semantics and never destructive REPLACE.
import_block=worker[worker.index("async function importChunk"):worker.index("async function finishImport")]
assert "INSERT OR REPLACE" not in import_block.upper()
assert "REPLACE INTO" not in import_block.upper()
assert "ON CONFLICT" in import_block
assert "RESTORE_USER_ROLE_CONFLICT" in import_block
assert "RESTORE_FIELD_KEY_CONFLICT" in import_block
assert "RESTORE_SIDEBAR_CATEGORY_CONFLICT" in import_block

# Frontend must use V3 chunked export, SHA-256 validation and full dry-run before any import chunk.
backup_ui=app[app.index("async function renderBackup"):app.index("const DRAFT_PREFIX")]
assert 'api("/api/admin/export")' not in backup_ui
assert "/api/admin/export-manifest" in backup_ui
assert "/api/admin/export-section" in backup_ui
assert "/api/admin/import-preview-chunk" in backup_ui
assert 'crypto.subtle.digest("SHA-256"' in backup_ui
assert "sha256" in backup_ui
assert "telegramSettings" in backup_ui
assert "telegramProgressRoutes" in backup_ui
assert "auditLogs" in backup_ui
assert "telegramDeliveryLogs" in backup_ui

preview_pos=backup_ui.index("/api/admin/import-preview-chunk")
write_pos=backup_ui.index("/api/admin/import-chunk")
assert preview_pos < write_pos

# V3 exports and restores in bounded network chunks.
assert "limit=1000" in backup_ui
assert "i+=200" in backup_ui

print("Batch 3 Backup/Restore V3 checks passed.")
