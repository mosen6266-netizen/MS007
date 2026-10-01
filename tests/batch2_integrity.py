import pathlib
import re
import sqlite3

root=pathlib.Path(__file__).resolve().parents[1]
worker=(root/"src/worker.js").read_text(encoding="utf-8")
app=(root/"public/app.js").read_text(encoding="utf-8")

# No duplicate named function declarations may shadow newer safety logic.
for file,source in [("worker",worker),("app",app)]:
    names=re.findall(r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(",source)
    duplicates=sorted({name for name in names if names.count(name)>1})
    assert not duplicates,(file,duplicates)

# Batch 2 invariants.
assert "FIELD_OPTION_IN_USE" in worker
assert "option-impact" in worker
assert "telegramStableFieldToken" in worker
assert "legacyToken" in worker
assert "dashboardWidgetsForProgress" in worker
assert "disabledDashboardWidgets" in worker
assert "deletedDashboardWidgets" in worker
assert 'data-audit-detail' in app
assert "保留旧选项并保存" in app

# Verify the relational cleanup sequence can be performed atomically against the schema.
con=sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys=ON")
con.executescript((root/"schema.sql").read_text(encoding="utf-8"))
for p in sorted((root/"migrations").glob("*.sql")):
    con.executescript(p.read_text(encoding="utf-8"))

con.execute("""INSERT INTO users(
  id,username,display_name,password_hash,password_salt,password_iterations,role,active,created_at,updated_at
) VALUES('u2','sales2','Sales 2','h','s',100000,'sales',1,datetime('now'),datetime('now'))""")
con.execute("""INSERT INTO customers(
  id,assigned_user_id,name,progress_done,progress_total,progress_percent,archived,
  created_by_id,created_at,updated_at,edit_version
) VALUES('c2','u2','C2',0,0,0,0,'u2',datetime('now'),datetime('now'),1)""")
con.execute("""INSERT INTO field_definitions(
  id,field_key,label,field_type,required,enabled,list_visible,list_sort_order,sort_order,
  options_json,searchable,created_at,updated_at
) VALUES('f2','f2','渠道','select',0,1,1,10,10,'["A","B"]',1,datetime('now'),datetime('now'))""")
con.execute("""INSERT INTO customer_values(customer_id,field_id,value,updated_at)
VALUES('c2','f2','B',datetime('now'))""")
con.execute("""INSERT INTO list_columns(id,audience,column_key,field_id,label,enabled,sort_order)
VALUES('lc2','admin','dynamic','f2','渠道',1,10)""")

# Permanent field cleanup must leave no FK reference behind.
con.execute("BEGIN")
con.execute("DELETE FROM customer_values WHERE field_id='f2'")
con.execute("DELETE FROM list_columns WHERE field_id='f2'")
con.execute("DELETE FROM field_definitions WHERE id='f2'")
con.execute("COMMIT")
assert con.execute("SELECT COUNT(*) FROM customer_values WHERE field_id='f2'").fetchone()[0]==0
assert con.execute("SELECT COUNT(*) FROM list_columns WHERE field_id='f2'").fetchone()[0]==0
assert con.execute("SELECT COUNT(*) FROM field_definitions WHERE id='f2'").fetchone()[0]==0

print("Batch 2 referential integrity checks passed.")
