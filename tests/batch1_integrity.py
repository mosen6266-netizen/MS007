import pathlib
import sqlite3

root=pathlib.Path(__file__).resolve().parents[1]
con=sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys=ON")
con.executescript((root/"schema.sql").read_text(encoding="utf-8"))
for p in sorted((root/"migrations").glob("*.sql")):
    con.executescript(p.read_text(encoding="utf-8"))

# Representative records.
con.execute(
    """INSERT INTO users(
      id,username,display_name,password_hash,password_salt,password_iterations,
      role,active,created_at,updated_at
    ) VALUES(?,?,?,?,?,100000,'sales',1,datetime('now'),datetime('now'))""",
    ("u_integrity","integrity_sales","Integrity Sales","hash","salt"),
)
con.execute(
    """INSERT INTO customers(
      id,assigned_user_id,name,progress_done,progress_total,progress_percent,
      archived,created_by_id,created_at,updated_at,edit_version
    ) VALUES(?,?,?,0,0,0,0,?,datetime('now'),datetime('now'),1)""",
    ("c_integrity","u_integrity","Before","u_integrity"),
)
con.execute(
    """INSERT INTO field_definitions(
      id,field_key,label,field_type,required,enabled,list_visible,
      list_sort_order,sort_order,options_json,searchable,created_at,updated_at
    ) VALUES('f_integrity','integrity_email','Integrity Email','email',1,1,0,999,999,'[]',1,datetime('now'),datetime('now'))"""
)

# The same guarded UPSERT shape used by atomic customer saves.
version=1
con.execute(
    """INSERT INTO customer_values(customer_id,field_id,value,updated_at)
       SELECT ?,?,?,datetime('now')
       WHERE EXISTS(SELECT 1 FROM customers WHERE id=? AND edit_version=?)
       ON CONFLICT(customer_id,field_id) DO UPDATE SET
         value=excluded.value,updated_at=excluded.updated_at""",
    ("c_integrity","f_integrity","first@example.com","c_integrity",version),
)
cur=con.execute(
    """UPDATE customers SET name=?,edit_version=edit_version+1
       WHERE id=? AND edit_version=?""",
    ("After","c_integrity",version),
)
assert cur.rowcount==1
assert con.execute("SELECT edit_version FROM customers WHERE id='c_integrity'").fetchone()[0]==2

# A stale editor must not be able to alter guarded detail values.
con.execute(
    """INSERT INTO customer_values(customer_id,field_id,value,updated_at)
       SELECT ?,?,?,datetime('now')
       WHERE EXISTS(SELECT 1 FROM customers WHERE id=? AND edit_version=?)
       ON CONFLICT(customer_id,field_id) DO UPDATE SET
         value=excluded.value,updated_at=excluded.updated_at""",
    ("c_integrity","f_integrity","stale@example.com","c_integrity",1),
)
value=con.execute(
    "SELECT value FROM customer_values WHERE customer_id='c_integrity' AND field_id='f_integrity'"
).fetchone()[0]
assert value=="first@example.com", value

# Guarded progress UPSERT must also obey the edit version.
con.execute(
    """INSERT INTO progress_definitions(
      id,label,description,enabled,sort_order,color,created_at,updated_at
    ) VALUES('p_integrity','Integrity Progress','',1,999,'#2563eb',datetime('now'),datetime('now'))"""
)
con.execute(
    """INSERT INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at)
       SELECT ?,?,?,?,datetime('now')
       WHERE EXISTS(SELECT 1 FROM customers WHERE id=? AND edit_version=?)
       ON CONFLICT(customer_id,progress_id) DO UPDATE SET
         completed=excluded.completed,
         completed_by=excluded.completed_by,
         completed_at=excluded.completed_at""",
    ("c_integrity","p_integrity",1,"u_integrity","c_integrity",2),
)
assert con.execute(
    "SELECT completed FROM customer_progress WHERE customer_id='c_integrity' AND progress_id='p_integrity'"
).fetchone()[0]==1

cur=con.execute(
    "UPDATE customers SET edit_version=edit_version+1 WHERE id=? AND edit_version=?",
    ("c_integrity",2),
)
assert cur.rowcount==1

# Stale version 2 cannot undo the version 3 progress.
con.execute(
    """INSERT INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at)
       SELECT ?,?,?,?,?,?
       WHERE 0""",
    ("noop","noop",0,None,None,None),
)
con.execute(
    """INSERT INTO customer_progress(customer_id,progress_id,completed,completed_by,completed_at)
       SELECT ?,?,?,?,NULL
       WHERE EXISTS(SELECT 1 FROM customers WHERE id=? AND edit_version=?)
       ON CONFLICT(customer_id,progress_id) DO UPDATE SET
         completed=excluded.completed,
         completed_by=excluded.completed_by,
         completed_at=excluded.completed_at""",
    ("c_integrity","p_integrity",0,"u_integrity","c_integrity",2),
)
assert con.execute(
    "SELECT completed FROM customer_progress WHERE customer_id='c_integrity' AND progress_id='p_integrity'"
).fetchone()[0]==1

worker=(root/"src/worker.js").read_text(encoding="utf-8")
app=(root/"public/app.js").read_text(encoding="utf-8")
assert "/api/admin/sales-options" in worker
assert "EDIT_CONFLICT" in worker
assert "saveCustomerAtomic" in worker
assert '/api/admin/sales-options' in app
assert 'method:"PUT",body' in app

print("Batch 1 customer integrity checks passed.")
