import pathlib
import sqlite3

root=pathlib.Path(__file__).resolve().parents[1]
worker=(root/"src/worker.js").read_text(encoding="utf-8")
app=(root/"public/app.js").read_text(encoding="utf-8")

for token in [
    "DRAFT_MAX_AGE_MS=7*24*60*60*1000",
    "function draftIsExpired",
    "function cleanupExpiredDraftsForUser",
    "cleanupExpiredDraftsForUser(draftUserId)",
]:
    assert token in app,token

draft_block=app[app.index("function setupOverlayDraft"):app.index("function hasUnsavedOverlay")]
assert "draftIsExpired(payload)" in draft_block
assert "localStorage.removeItem(storageKey)" in draft_block

for token in [
    "async function telegramQueueMonitor",
    "async function retryTelegramQueueItem",
    "MAX_AUTO_ATTEMPTS=8",
    "requires_admin",
    "dead_lettered_at",
    "needs_admin",
    "retryTelegramQueueItem(env,user,m[1],ctx)",
]:
    assert token in worker,token

process=worker[worker.index("async function processTelegramQueue"):worker.index("async function telegramAdminGet")]
assert "COALESCE(requires_admin,0)=0" in process
assert "requires_admin=1" in process
assert "attempts<MAX_AUTO_ATTEMPTS" in process
assert process.count('DELETE FROM telegram_send_queue WHERE id=?') == 1

telegram_ui=app[app.index("async function renderTelegramSettings"):app.index("async function renderCapacity")]
for token in [
    "Telegram 队列监控",
    "queueMonitor.pendingCount",
    "queueMonitor.retryCount",
    "queueMonitor.needsAdminCount",
    "queueMonitor.oldestWaitSeconds",
    "queueMonitor.recentSuccessRate",
    "需要管理员处理",
    "data-tg-retry",
    "手动重试",
]:
    assert token in telegram_ui,token

con=sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys=ON")
con.executescript((root/"schema.sql").read_text(encoding="utf-8"))
for p in sorted((root/"migrations").glob("*.sql")):
    con.executescript(p.read_text(encoding="utf-8"))
cols={r[1] for r in con.execute("PRAGMA table_info(telegram_send_queue)")}
assert "requires_admin" in cols
assert "dead_lettered_at" in cols

print("Batch 5 draft/Telegram reliability checks passed.")
