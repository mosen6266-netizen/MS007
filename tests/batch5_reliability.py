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
    "async function telegramUnresolvedItems",
    "async function telegramRetryableFailureItems",
    "async function telegramUnresolvedAdminGet",
    "async function retryTelegramQueueItem",
    "async function retryTelegramDeliveryLog",
    "async function retryFailedTelegramBatch",
    "MAX_AUTO_ATTEMPTS=8",
    "requires_admin",
    "dead_lettered_at",
    "needs_admin",
    "retryTelegramQueueItem(env,user,m[1],ctx)",
    "retryTelegramDeliveryLog(request,env,user,m[1],ctx)",
    "/api/admin/telegram/unresolved",
    "/api/admin/telegram/retry-failed-batch",
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
    "未发送成功",
    "tgUnresolvedBody",
    "tgUnresolvedRefresh",
    "tgRetryAllFailed",
    "一键重新发送全部失败",
    "/api/admin/telegram/retry-failed-batch",
    "data-tg-unresolved-retry",
    "/api/admin/telegram/unresolved",
    "每 5 秒自动检查一次",
    "需要管理员处理",
    "data-tg-retry",
    "手动重试",
]:
    assert token in telegram_ui,token

# The unresolved center must merge live queue rows with unresolved failed/skipped
# delivery logs, and hide old failures after a later success or a newer queue item.
unresolved=worker[worker.index("async function telegramUnresolvedItems"):worker.index("async function telegramQueueMonitor")]
for token in [
    "FROM telegram_send_queue q",
    "l.status IN ('failed','skipped')",
    "s.status='success'",
    "NOT EXISTS",
    "q2.progress_id IS l.progress_id",
]:
    assert token in unresolved,token

# Successful sends delete the queue row, so the unresolved center automatically
# loses pending/retry/admin-attention entries once Telegram accepts the message.
process=worker[worker.index("async function processTelegramQueue"):worker.index("async function telegramAdminGet")]
assert "status:\"success\"" in process
assert 'DELETE FROM telegram_send_queue WHERE id=?' in process

# Manual resend supports both live queue items and historical failed/skipped logs.
retry_log=worker[worker.index("async function retryTelegramDeliveryLog"):worker.index("async function bumpVersion")]
for token in [
    "sendTelegramProgressNotification",
    "{manual:true}",
    "Telegram Bot Token 未设置",
    "这个进度没有可用的通知群",
]:
    assert token in retry_log,token

# One-click resend-all must stage work in small batches and leave actual
# Telegram delivery to the existing rate-limited reliable queue.
bulk=worker[worker.index("async function retryFailedTelegramBatch"):worker.index("async function bumpVersion")]
for token in [
    "const BATCH_SIZE=10",
    "telegramRetryableFailureItems(env,500)",
    "requires_admin=0",
    "{manual:true,processImmediately:false}",
    "maxItems:2",
    "hasMoreActionable",
]:
    assert token in bulk,token
assert "status===\"pending\"" not in bulk
assert "status===\"retry\"" not in bulk

failure_query=worker[worker.index("async function telegramRetryableFailureItems"):worker.index("async function telegramUnresolvedAdminGet")]
assert "COALESCE(q.requires_admin,0)=1" in failure_query
assert "l.status IN ('failed','skipped')" in failure_query
assert "telegram_send_queue q2" in failure_query
assert "s.status='success'" in failure_query

sender=worker[worker.index("async function sendTelegramProgressNotification"):worker.index("async function retryTelegramDeliveryLog")]
assert "options?.processImmediately!==false" in sender

assert "每批最多 10 条" in telegram_ui
assert "setTimeout(resolve,900)" in telegram_ui
assert "telegramHasRetryableFailures" in telegram_ui

con=sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys=ON")
con.executescript((root/"schema.sql").read_text(encoding="utf-8"))
for p in sorted((root/"migrations").glob("*.sql")):
    con.executescript(p.read_text(encoding="utf-8"))
cols={r[1] for r in con.execute("PRAGMA table_info(telegram_send_queue)")}
assert "requires_admin" in cols
assert "dead_lettered_at" in cols

print("Batch 5 draft/Telegram reliability checks passed.")
