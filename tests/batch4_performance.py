import pathlib
import sqlite3

root=pathlib.Path(__file__).resolve().parents[1]
worker=(root/"src/worker.js").read_text(encoding="utf-8")
app=(root/"public/app.js").read_text(encoding="utf-8")

# Derived search index + background maintenance must exist.
for token in [
    "customer_search_index","maintenance_jobs","search_index_rebuild","progress_recalc",
    "processMaintenanceBatch","search_index_ready_v1","rebuildCustomerSearchIndex",
    "capacity_snapshot_v1","45*60*1000"
]:
    assert token in worker,token

# Search switches only after derived-index verification and keeps a safe fallback beforehand.
list_block=worker[worker.index("async function listCustomers"):worker.index("async function validateCustomerName")]
assert 'getSystemSetting(env,"search_index_ready_v1",false)' in list_block
assert "customer_search_index" in list_block
assert "customer_values cv" in list_block
assert "fd.field_type IN ('phone','email')" in list_block
assert "案件编号" in list_block

# Customer writes incrementally sync the index.
assert worker.count("await rebuildCustomerSearchIndex(env,id);") >= 4

# Global progress recalculation is queued; it must not synchronously UPDATE every customer.
recalc=worker[worker.index("async function recalcAllProgress"):worker.index("async function listCustomers")]
assert 'queueMaintenanceJob(env,"progress_recalc")' in recalc
assert "UPDATE customers" not in recalc

# The scheduled handler must advance maintenance and refresh capacity cache.
scheduled=worker[worker.rindex("async scheduled"):worker.rindex("};")]
assert "processMaintenanceBatch" in scheduled
assert "refreshCapacitySnapshotIfStale" in scheduled

# Audit, recycle bin, and Telegram full history use keyset cursors, not OFFSET.
for start,end in [
    ("async function telegramLogs","async function telegramAdminSave"),
    ("async function recycleList","async function restoreCustomer"),
    ("async function auditList","async function exportBusinessData"),
]:
    block=worker[worker.index(start):worker.index(end)]
    assert "decodeCursor" in block
    assert "nextCursor" in block
    assert "OFFSET" not in block.upper()
    assert "LIMIT ?" in block

# Frontend no longer sends page/OFFSET pagination for these three history views.
audit_ui=app[app.index("async function renderAudit"):app.index("async function renderRecycle")]
recycle_ui=app[app.index("async function renderRecycle"):app.index("async function renderBackup")]
telegram_ui=app[app.index('let telegramLogMode="recent"'):app.index("async function renderCapacity")]
for block in [audit_ui,recycle_ui,telegram_ui]:
    assert 'qs.set("cursor"' in block or 'new URLSearchParams({limit:"50"})' in block
    assert "nextCursor" in block
    assert 'page:String' not in block

# Migration must be safe and idempotent on a fresh schema+migrations database.
con=sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys=ON")
con.executescript((root/"schema.sql").read_text(encoding="utf-8"))
for p in sorted((root/"migrations").glob("*.sql")):
    con.executescript(p.read_text(encoding="utf-8"))
tables={r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
assert "customer_search_index" in tables
assert "maintenance_jobs" in tables
job=con.execute("SELECT status FROM maintenance_jobs WHERE task_key='search_index_rebuild'").fetchone()
assert job and job[0] in ("pending","running","complete","failed")

print("Batch 4 performance checks passed.")
