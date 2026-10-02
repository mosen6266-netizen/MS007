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

# V3 exports must freeze section membership at manifest time so append-only
# audit/Telegram rows created during a long export cannot change record counts.
for token in [
    "BACKUP_V3_ROWID_BOUNDARIES",
    "backupSectionSqlWithBoundary",
    "COALESCE(MAX(rowid),0) max_rowid",
    "maxRowid",
    "snapshotMaxRowid",
]:
    assert token in worker,token

manifest_block=worker[worker.index("async function exportBackupManifest"):worker.index("async function exportBackupSection")]
assert "sections[section]" in manifest_block
assert "maxRowid" in manifest_block
assert manifest_block.index("COALESCE(MAX(rowid),0)") < manifest_block.index('audit(env,user,"export_manifest"')

section_block=worker[worker.index("async function exportBackupSection"):worker.index("async function importPreviewChunk")]
assert "backupSectionSqlWithBoundary" in section_block
assert ".bind(maxRowid,limit,offset)" in section_block

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
assert "sectionSpec.maxRowid" in backup_ui
assert "maxRowid=" in backup_ui
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

# Rowid snapshot proof: a row appended after manifest creation must not alter
# the number of rows exported from that snapshot.
import sqlite3
con=sqlite3.connect(":memory:")
con.execute("CREATE TABLE audit_logs(id TEXT PRIMARY KEY,created_at TEXT)")
con.executemany(
    "INSERT INTO audit_logs(id,created_at) VALUES(?,?)",
    [(f"a{i}",f"2026-10-02T00:00:{i%60:02d}Z") for i in range(1446)]
)
count,max_rowid=con.execute("SELECT COUNT(*),COALESCE(MAX(rowid),0) FROM audit_logs").fetchone()
assert count==1446
con.execute("INSERT INTO audit_logs(id,created_at) VALUES('export_manifest','2026-10-02T00:10:00Z')")
assert con.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0]==1447
assert con.execute("SELECT COUNT(*) FROM audit_logs WHERE rowid<=?",(max_rowid,)).fetchone()[0]==1446

print("Batch 3 Backup/Restore V3 checks passed.")
