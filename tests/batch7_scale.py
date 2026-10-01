import json
import pathlib
import sqlite3
import time
from datetime import datetime, timedelta, timezone

root = pathlib.Path(__file__).resolve().parents[1]
worker = (root / "src/worker.js").read_text(encoding="utf-8")

# Batch 7.2 cache wiring must remain present.
for token in [
    "dashboard_statistics_cache",
    "dashboardStatisticsCacheKey",
    "readDashboardStatisticsCache",
    "writeDashboardStatisticsCache",
    "invalidateDashboardStatistics",
    "withDashboardStatisticsInvalidation",
    'dashboardStatisticsCacheKey("bundle"',
    "withDashboardStatisticsInvalidation(env,createCustomer",
    "withDashboardStatisticsInvalidation(env,saveCustomerAtomic",
    "withDashboardStatisticsInvalidation(env,toggleProgress",
    "withDashboardStatisticsInvalidation(env,restoreCustomer",
    "if(rows.length)await invalidateDashboardStatistics(env);",
]:
    assert token in worker, token


def build_db():
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=MEMORY")
    con.execute("PRAGMA synchronous=OFF")
    con.executescript((root / "schema.sql").read_text(encoding="utf-8"))
    for p in sorted((root / "migrations").glob("*.sql")):
        con.executescript(p.read_text(encoding="utf-8"))
    return con


con = build_db()
tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
assert "dashboard_statistics_cache" in tables

now = "2026-10-02T00:00:00Z"
admin_id = "stress_admin"
con.execute(
    """INSERT INTO users(
       id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at
       ) VALUES(?,?,?,?,?,100000,'admin',1,?,?)""",
    (admin_id, "stress_admin", "Stress Admin", "x", "x", now, now),
)

sales_ids = [f"stress_sales_{i:02d}" for i in range(25)]
con.executemany(
    """INSERT INTO users(
       id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at
       ) VALUES(?,?,?,?,?,100000,'sales',1,?,?)""",
    [(sid, sid, f"Sales {i:02d}", "x", "x", now, now) for i, sid in enumerate(sales_ids)],
)

progress_ids = [f"stress_p_{i}" for i in range(5)]
con.executemany(
    """INSERT INTO progress_definitions(
       id,label,description,enabled,sort_order,color,created_at,updated_at
       ) VALUES(?,?,?,1,?,'#2563eb',?,?)""",
    [(pid, f"Stress Progress {i}", "", 1000 + i, now, now) for i, pid in enumerate(progress_ids)],
)

TOTAL = 20_000
base = datetime(2026, 1, 1, tzinfo=timezone.utc)
customers = []
progress_rows = []

for i in range(TOTAL):
    cid = f"stress_c_{i:05d}"
    owner = sales_ids[i % len(sales_ids)]
    dt = base + timedelta(seconds=i)
    ts = dt.isoformat().replace("+00:00", "Z")
    archived = 1 if i % 17 == 0 else 0
    deleted_at = ts if i % 29 == 0 else None
    done = i % 6
    pct = min(100, done * 20)
    customers.append(
        (cid, owner, f"Stress Customer {i:05d}", done, 5, pct, archived, deleted_at, admin_id, ts, ts)
    )
    # Two completed progress records per customer gives 40k rows and exercises the
    # progress aggregation indexes without making CI excessively slow.
    p1 = progress_ids[i % len(progress_ids)]
    p2 = progress_ids[(i + 1) % len(progress_ids)]
    progress_rows.append((cid, p1, 1, owner, ts))
    progress_rows.append((cid, p2, 1, owner, ts))

t0 = time.perf_counter()
con.executemany(
    """INSERT INTO customers(
       id,assigned_user_id,name,progress_done,progress_total,progress_percent,archived,
       deleted_at,created_by_id,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
    customers,
)
con.executemany(
    """INSERT INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at)
       VALUES(?,?,?,?,?)""",
    progress_rows,
)
con.commit()
seed_seconds = time.perf_counter() - t0
assert con.execute("SELECT COUNT(*) FROM customers WHERE id LIKE 'stress_c_%'").fetchone()[0] == TOTAL
assert con.execute("SELECT COUNT(*) FROM customer_progress WHERE customer_id LIKE 'stress_c_%'").fetchone()[0] == TOTAL * 2

# Keyset pagination: fixed page size, deterministic order, no duplicate rows.
page1 = con.execute(
    """SELECT id,updated_at FROM customers
       WHERE deleted_at IS NULL AND archived=0
       ORDER BY updated_at DESC,id DESC LIMIT 51"""
).fetchall()
assert len(page1) == 51
cursor_time, cursor_id = page1[49][1], page1[49][0]
page2 = con.execute(
    """SELECT id,updated_at FROM customers
       WHERE deleted_at IS NULL AND archived=0
         AND (updated_at < ? OR (updated_at=? AND id < ?))
       ORDER BY updated_at DESC,id DESC LIMIT 51""",
    (cursor_time, cursor_time, cursor_id),
).fetchall()
assert len(page2) == 51
assert not ({r[0] for r in page1[:50]} & {r[0] for r in page2[:50]})

# The large customer list must be index-backed rather than a full table scan.
plan = " ".join(
    str(x)
    for row in con.execute(
        """EXPLAIN QUERY PLAN
           SELECT id,updated_at FROM customers
           WHERE deleted_at IS NULL AND archived=0
           ORDER BY updated_at DESC,id DESC LIMIT 51"""
    ).fetchall()
    for x in row
)
assert "idx_customers_archived" in plan, plan

owner_plan = " ".join(
    str(x)
    for row in con.execute(
        """EXPLAIN QUERY PLAN
           SELECT id,updated_at FROM customers
           WHERE assigned_user_id=? AND deleted_at IS NULL
           ORDER BY updated_at DESC,id DESC LIMIT 51""",
        (sales_ids[0],),
    ).fetchall()
    for x in row
)
assert "idx_customers_assigned" in owner_plan, owner_plan

# Exercise the same aggregation shapes used by statsBundle() at 20k-customer scale.
today_from = "2026-01-01T03:00:00Z"
week_from = "2026-01-01T02:00:00Z"
month_from = "2026-01-01T01:00:00Z"

t1 = time.perf_counter()
customers_agg = con.execute(
    """SELECT
       COUNT(*) total,
       SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) today,
       SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) week,
       SUM(CASE WHEN c.created_at>=? THEN 1 ELSE 0 END) month
       FROM customers c
       WHERE c.deleted_at IS NULL AND c.archived=0""",
    (today_from, week_from, month_from),
).fetchone()

completed_agg = con.execute(
    """WITH completed_dates AS (
       SELECT c.id,MAX(cp.completed_at) completed_at
       FROM customers c
       JOIN customer_progress cp ON cp.customer_id=c.id AND cp.completed=1
       WHERE c.deleted_at IS NULL AND c.archived=0 AND c.progress_percent=100
       GROUP BY c.id
       )
       SELECT COUNT(*) total,
       SUM(CASE WHEN completed_at>=? THEN 1 ELSE 0 END) today,
       SUM(CASE WHEN completed_at>=? THEN 1 ELSE 0 END) week,
       SUM(CASE WHEN completed_at>=? THEN 1 ELSE 0 END) month
       FROM completed_dates""",
    (today_from, week_from, month_from),
).fetchone()

progress_agg = con.execute(
    """SELECT cp.progress_id,
       COUNT(DISTINCT cp.customer_id) total,
       COUNT(DISTINCT CASE WHEN cp.completed_at>=? THEN cp.customer_id END) today,
       COUNT(DISTINCT CASE WHEN cp.completed_at>=? THEN cp.customer_id END) week,
       COUNT(DISTINCT CASE WHEN cp.completed_at>=? THEN cp.customer_id END) month
       FROM customer_progress cp
       JOIN customers c ON c.id=cp.customer_id
       WHERE cp.completed=1 AND c.deleted_at IS NULL AND c.archived=0
       GROUP BY cp.progress_id""",
    (today_from, week_from, month_from),
).fetchall()

sales_agg = con.execute(
    """SELECT u.id,COUNT(c.id) total_count,COALESCE(ROUND(AVG(c.progress_percent)),0) avg_total
       FROM users u
       LEFT JOIN customers c ON c.assigned_user_id=u.id
         AND c.deleted_at IS NULL AND c.archived=0
       WHERE u.role='sales'
       GROUP BY u.id
       HAVING u.active=1 OR COUNT(c.id)>0"""
).fetchall()
aggregate_seconds = time.perf_counter() - t1

assert customers_agg[0] > 10_000
assert completed_agg[0] >= 0
assert len(progress_agg) >= len(progress_ids)
assert len(sales_agg) >= len(sales_ids)
# Wide ceiling: catches accidental catastrophic regressions while remaining stable on shared CI.
assert aggregate_seconds < 8.0, aggregate_seconds

# Cache read/upsert/invalidation semantics.
payload = {
    "ok": True,
    "boundaries": {"todayFrom": today_from, "weekFrom": week_from, "monthFrom": month_from},
    "periods": {"total": {"summary": {"total": int(customers_agg[0])}}},
}
cache_key = "v1|bundle|admin|all|stress"
con.execute(
    """INSERT INTO dashboard_statistics_cache(cache_key,value_json,updated_at)
       VALUES(?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at""",
    (cache_key, json.dumps(payload), now),
)
cached = con.execute(
    "SELECT value_json FROM dashboard_statistics_cache WHERE cache_key=?", (cache_key,)
).fetchone()
assert json.loads(cached[0])["periods"]["total"]["summary"]["total"] == customers_agg[0]
con.execute("DELETE FROM dashboard_statistics_cache")
assert con.execute("SELECT COUNT(*) FROM dashboard_statistics_cache").fetchone()[0] == 0

# Large backup/restore compatibility: round-trip the high-volume relational core into a
# second fresh database and verify counts. This does not touch production data.
backup_users = con.execute(
    "SELECT * FROM users WHERE id=? OR id LIKE 'stress_sales_%'", (admin_id,)
).fetchall()
backup_progress = con.execute(
    "SELECT * FROM progress_definitions WHERE id LIKE 'stress_p_%'"
).fetchall()
backup_customers = con.execute(
    "SELECT * FROM customers WHERE id LIKE 'stress_c_%' ORDER BY id"
).fetchall()
backup_cp = con.execute(
    "SELECT * FROM customer_progress WHERE customer_id LIKE 'stress_c_%' ORDER BY customer_id,progress_id"
).fetchall()

restore = build_db()

def copy_rows(src, dst, table, rows):
    if not rows:
        return
    cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})").fetchall()]
    placeholders = ",".join("?" for _ in cols)
    dst.executemany(
        f"INSERT OR REPLACE INTO {table}({','.join(cols)}) VALUES({placeholders})",
        rows,
    )

copy_rows(con, restore, "users", backup_users)
copy_rows(con, restore, "progress_definitions", backup_progress)
copy_rows(con, restore, "customers", backup_customers)
copy_rows(con, restore, "customer_progress", backup_cp)
restore.commit()

assert restore.execute("SELECT COUNT(*) FROM customers WHERE id LIKE 'stress_c_%'").fetchone()[0] == TOTAL
assert restore.execute(
    "SELECT COUNT(*) FROM customer_progress WHERE customer_id LIKE 'stress_c_%'"
).fetchone()[0] == TOTAL * 2

print(
    "Batch 7 scale checks passed:",
    f"customers={TOTAL}",
    f"progress_rows={TOTAL * 2}",
    f"seed={seed_seconds:.3f}s",
    f"aggregates={aggregate_seconds:.3f}s",
)
