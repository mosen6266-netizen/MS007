"""
MS007 Batch 6 business regression guard.

This suite intentionally checks contracts and data rules rather than UI pixels.
It protects the existing customer-management behavior before refactoring.
"""
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]


def build_db():
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
    for migration in sorted((ROOT / "migrations").glob("*.sql")):
        con.executescript(migration.read_text(encoding="utf-8"))
    return con


def test_required_tables():
    con = build_db()
    tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    required = {
        "users", "sessions", "customers", "customer_values",
        "field_definitions", "progress_definitions",
        "customer_progress", "audit_logs", "sidebar_items",
        "telegram_send_queue", "telegram_delivery_logs"
    }
    missing = required - tables
    assert not missing, f"missing tables: {sorted(missing)}"


def test_customer_lifecycle_preserves_links():
    con = build_db()
    con.execute("insert into users(id,username,role) values(1,'admin','admin')")
    con.execute("insert into users(id,username,role) values(2,'sales','sales')")
    con.execute("insert into customers(id,name,owner_id) values(10,'Regression Customer',2)")
    row = con.execute("select owner_id from customers where id=10").fetchone()
    assert row[0] == 2


def test_custom_configuration_storage_exists():
    con = build_db()
    for table in ["field_definitions", "progress_definitions", "sidebar_items"]:
        count = con.execute(
            "select count(*) from sqlite_master where type='table' and name=?",
            (table,)
        ).fetchone()[0]
        assert count == 1, table


def test_backup_relevant_entities_have_stable_ids():
    con = build_db()
    entities = ["customers", "users", "field_definitions", "progress_definitions"]
    for table in entities:
        cols = {r[1] for r in con.execute(f"pragma table_info({table})")}
        assert "id" in cols, f"{table} has no stable id"


def test_telegram_batch5_contract_remains():
    con = build_db()
    cols = {r[1] for r in con.execute("pragma table_info(telegram_send_queue)")}
    assert "requires_admin" in cols
    assert "dead_lettered_at" in cols


if __name__ == "__main__":
    test_required_tables()
    test_customer_lifecycle_preserves_links()
    test_custom_configuration_storage_exists()
    test_backup_relevant_entities_have_stable_ids()
    test_telegram_batch5_contract_remains()
    print("Batch 6 business regression checks passed.")
