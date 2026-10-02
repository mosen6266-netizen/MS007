import pathlib
import sqlite3

root=pathlib.Path(__file__).resolve().parents[1]
worker=(root/"src/worker.js").read_text(encoding="utf-8")
app=(root/"public/app.js").read_text(encoding="utf-8")
schema=(root/"schema.sql").read_text(encoding="utf-8")
migration=(root/"migrations/0006_daily_telegram_work_plan.sql").read_text(encoding="utf-8")

for token in [
    "CREATE TABLE IF NOT EXISTS daily_plan_settings",
    "CREATE TABLE IF NOT EXISTS daily_plan_runs",
    "send_time_beijing",
    "sa_daily_plan",
    "#/admin/daily-plan",
]:
    assert token in schema or token in migration,token

for token in [
    "async function dailyPlanBuild",
    "async function dailyPlanAdminGet",
    "async function dailyPlanAdminSave",
    "async function dailyPlanPreview",
    "async function dailyPlanSendNow",
    "async function processDueDailyPlans",
    'maxSales=3',
    'dailyplan:',
    'dailyPlanMarkQueueState',
    '/api/admin/daily-plans',
    'processDueDailyPlans(env,{maxSales:3})',
    '"dailyPlanSettings"',
]:
    assert token in worker,token

# The independent daily plan must still use the mature Telegram queue.
daily=worker[worker.index("const DAILY_PLAN_FIELD_SETTING_KEY"):worker.index("async function telegramAdminGet")]
for token in [
    "enqueueTelegramMessage",
    "telegramSettingsRow",
    "北京时间",
    "未开始",
    "已全部完成",
    "3400",
]:
    assert token in daily,token

# Scheduled runs use a deterministic per-salesperson/day dedupe key.
assert '["dailyplan",salesUserId,date,String(i+1)].join(":")' in daily
assert 'dailyplan-manual' in daily

for token in [
    "async function renderDailyPlan",
    "每日工作计划",
    "北京时间 UTC+8",
    "日报字段对应",
    "业务员推送设置",
    "data-daily-preview",
    "data-daily-send",
    'page==="daily-plan"',
    '"calendar":"🗓"',
]:
    assert token in app,token

# Existing Telegram settings page remains a separate route/function.
assert 'page==="telegram"' in app
assert "async function renderTelegramSettings" in app

con=sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys=ON")
con.executescript(schema)
for p in sorted((root/"migrations").glob("*.sql")):
    con.executescript(p.read_text(encoding="utf-8"))

tables={r[0] for r in con.execute("select name from sqlite_master where type='table'")}
assert "daily_plan_settings" in tables
assert "daily_plan_runs" in tables
item=con.execute("select label,url,group_label from sidebar_items where id='sa_daily_plan'").fetchone()
assert item==("每日工作计划","#/admin/daily-plan","通知")

print("Daily Telegram work plan checks passed.")
