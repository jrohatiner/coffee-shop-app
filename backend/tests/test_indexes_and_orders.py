import os
import tempfile
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

# Point app.database at an isolated temp SQLite database during standalone import
_IMPORT_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_IMPORT_DB.close()
os.environ.setdefault("JWT_SECRET", "super-secret-test-key-for-auth-tests")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_IMPORT_DB.name}")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Column, Index, Integer, MetaData, String, Table, create_engine, event, inspect, text
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateIndex

from app import auth, models
from app.database import Base, get_db
from app.main import app, ensure_indexes


def teardown_module(module):
    if os.path.exists(_IMPORT_DB.name):
        os.unlink(_IMPORT_DB.name)


@pytest.fixture()
def db_env(tmp_path):
    db_file = tmp_path / "test_coffee_shop.db"
    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _enable_sqlite_fks(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    with engine.begin() as conn:
        Base.metadata.create_all(bind=conn)
        ensure_indexes(bind_engine=conn)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    previous_overrides = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    try:
        yield engine, TestingSessionLocal, client
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        engine.dispose()


def _auth_headers(username: str) -> dict:
    token = auth.create_access_token({"sub": username})
    return {"Authorization": f"Bearer {token}"}


def test_fresh_database_has_all_secondary_btree_indexes(db_env):
    engine, _, _ = db_env
    inspector = inspect(engine)

    order_index_cols = {
        tuple(idx["column_names"]) for idx in inspector.get_indexes("orders")
    }
    assert ("user_id",) in order_index_cols
    assert ("created_at",) in order_index_cols
    assert ("status", "created_at") in order_index_cols

    order_item_index_cols = {
        tuple(idx["column_names"]) for idx in inspector.get_indexes("order_items")
    }
    assert ("order_id",) in order_item_index_cols
    assert ("product_id",) in order_item_index_cols

    report_index_cols = {
        tuple(idx["column_names"]) for idx in inspector.get_indexes("sales_reports")
    }
    assert ("report_type", "created_at") in report_index_cols


def test_existing_database_receives_missing_indexes_on_startup(tmp_path):
    legacy_db = tmp_path / "legacy.db"
    legacy_engine = create_engine(
        f"sqlite:///{legacy_db}",
        connect_args={"check_same_thread": False},
    )

    # Simulate an existing deployment created before secondary indexes existed
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE users (
                    id INTEGER NOT NULL PRIMARY KEY,
                    username VARCHAR UNIQUE,
                    hashed_password VARCHAR,
                    is_manager BOOLEAN
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE products (
                    id INTEGER NOT NULL PRIMARY KEY,
                    name VARCHAR UNIQUE,
                    price FLOAT,
                    stock INTEGER
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE orders (
                    id INTEGER NOT NULL PRIMARY KEY,
                    user_id INTEGER REFERENCES users (id),
                    status VARCHAR,
                    created_at DATETIME
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE order_items (
                    id INTEGER NOT NULL PRIMARY KEY,
                    order_id INTEGER REFERENCES orders (id),
                    product_id INTEGER REFERENCES products (id),
                    quantity INTEGER
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE sales_reports (
                    id INTEGER NOT NULL PRIMARY KEY,
                    report_type VARCHAR,
                    total_sales FLOAT,
                    created_at DATETIME
                )
                """
            )
        )
        conn.execute(
            text(
                "INSERT INTO users (id, username, hashed_password, is_manager) "
                "VALUES (1, 'legacy_mgr', 'hash', 1)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO orders (id, user_id, status, created_at) "
                "VALUES (1, 1, 'completed', '2026-05-01 10:00:00.000000')"
            )
        )

    # Base.metadata.create_all alone skips indexes on pre-existing tables
    Base.metadata.create_all(bind=legacy_engine)
    before_orders = {
        tuple(idx["column_names"])
        for idx in inspect(legacy_engine).get_indexes("orders")
    }
    assert ("status", "created_at") not in before_orders

    # Startup ensure_indexes creates all missing indexes on 1 connection checkout
    # and is idempotent on repeat runs (1 checkout, 19 reflection queries, 0 DDL)
    backfill_checkouts = []
    backfill_statements = []

    def _on_checkout(_dbapi_conn, _conn_record, _conn_proxy):
        backfill_checkouts.append(1)

    def _on_execute(_conn, _cursor, statement, _params, _context, _executemany):
        backfill_statements.append(statement)

    event.listen(legacy_engine, "checkout", _on_checkout)
    event.listen(legacy_engine, "before_cursor_execute", _on_execute)
    try:
        ensure_indexes(bind_engine=legacy_engine)
        assert len(backfill_checkouts) == 1
        created_ddl = [
            stmt
            for stmt in backfill_statements
            if stmt.lstrip().upper().startswith(("CREATE INDEX", "CREATE UNIQUE INDEX"))
        ]
        assert len(created_ddl) == 13

        backfill_checkouts.clear()
        backfill_statements.clear()

        ensure_indexes(bind_engine=legacy_engine)
        assert len(backfill_checkouts) == 1
        assert len(backfill_statements) == 19
        assert not any(
            stmt.lstrip().upper().startswith(("CREATE INDEX", "CREATE UNIQUE INDEX"))
            for stmt in backfill_statements
        )
    finally:
        event.remove(legacy_engine, "checkout", _on_checkout)
        event.remove(legacy_engine, "before_cursor_execute", _on_execute)

    inspector = inspect(legacy_engine)
    assert {tuple(i["column_names"]) for i in inspector.get_indexes("orders")} >= {
        ("user_id",),
        ("created_at",),
        ("status", "created_at"),
    }
    assert {tuple(i["column_names"]) for i in inspector.get_indexes("order_items")} >= {
        ("order_id",),
        ("product_id",),
    }
    assert {
        tuple(i["column_names"]) for i in inspector.get_indexes("sales_reports")
    } >= {
        ("report_type", "created_at"),
    }

    # Existing records remain intact
    with legacy_engine.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM orders")).scalar_one()
        assert count == 1

    legacy_engine.dispose()


def test_warm_startup_and_ensure_indexes_use_single_checkout_and_batched_reflection(
    tmp_path,
):
    db_path = tmp_path / "warm_startup.db"
    warm_engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    with warm_engine.begin() as conn:
        Base.metadata.create_all(bind=conn)
        ensure_indexes(bind_engine=conn)

    checkouts = []
    statements = []

    @event.listens_for(warm_engine, "checkout")
    def _record_checkout(_dbapi_conn, _conn_record, _conn_proxy):
        checkouts.append(1)

    @event.listens_for(warm_engine, "before_cursor_execute")
    def _record_statement(_conn, _cursor, statement, _params, _context, _executemany):
        statements.append(statement)

    # 1. Standalone ensure_indexes(bind_engine=Engine) -> 1 checkout, 19 reflection queries
    ensure_indexes(bind_engine=warm_engine)
    assert len(checkouts) == 1
    assert len(statements) == 19
    assert not any(
        stmt.lstrip().upper().startswith("CREATE") for stmt in statements
    )

    # 2. Shared startup transaction (create_all + ensure_indexes on Connection) -> 1 checkout
    checkouts.clear()
    statements.clear()
    with warm_engine.begin() as conn:
        Base.metadata.create_all(bind=conn)
        ensure_indexes(bind_engine=conn)

    assert len(checkouts) == 1
    assert len(statements) == 24
    assert not any(
        stmt.lstrip().upper().startswith("CREATE") for stmt in statements
    )

    warm_engine.dispose()


def test_ensure_indexes_handles_missing_tables_unnamed_and_duplicate_indexes(tmp_path):
    empty_db = tmp_path / "empty.db"
    empty_engine = create_engine(
        f"sqlite:///{empty_db}",
        connect_args={"check_same_thread": False},
    )

    checkouts = []
    statements = []
    event.listen(empty_engine, "checkout", lambda *_args: checkouts.append(1))
    event.listen(
        empty_engine,
        "before_cursor_execute",
        lambda _c, _cur, stmt, *_a: statements.append(stmt),
    )

    # Calling ensure_indexes before tables exist skips absent tables without raising
    ensure_indexes(bind_engine=empty_engine)
    assert len(checkouts) == 1
    assert len(statements) == 1

    # Verify unnamed index fallback and same-pass duplicate named index protection
    custom_meta = MetaData()
    sample_table = Table(
        "sample_items",
        custom_meta,
        Column("id", Integer, primary_key=True),
        Column("code", String),
        Column("label", String),
    )
    unnamed_idx = Index(None, sample_table.c.code)
    dup_idx_one = Index("ix_sample_items_label", sample_table.c.label)
    dup_idx_two = Index("ix_sample_items_label", sample_table.c.label)
    sample_table.indexes.update({unnamed_idx, dup_idx_one, dup_idx_two})

    with empty_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE sample_items (id INTEGER PRIMARY KEY, code VARCHAR, label VARCHAR)"
            )
        )

    checkouts.clear()
    statements.clear()
    with patch.object(Base, "metadata", custom_meta):
        with empty_engine.connect() as conn:
            ensure_indexes(bind_engine=conn)

    assert len(checkouts) == 1
    create_index_stmts = [
        stmt
        for stmt in statements
        if stmt.lstrip().upper().startswith("CREATE INDEX")
    ]
    assert len(create_index_stmts) == 2

    reflected_cols = {
        tuple(idx["column_names"])
        for idx in inspect(empty_engine).get_indexes("sample_items")
    }
    assert ("code",) in reflected_cols
    assert ("label",) in reflected_cols

    empty_engine.dispose()


def test_indexes_compile_cleanly_for_postgresql_and_sqlite():
    pg_dialect = postgresql.dialect()
    sq_dialect = sqlite.dialect()
    for table in Base.metadata.tables.values():
        for index in table.indexes:
            pg_ddl = str(CreateIndex(index).compile(dialect=pg_dialect))
            sq_ddl = str(CreateIndex(index).compile(dialect=sq_dialect))
            assert "CREATE" in pg_ddl and "INDEX" in pg_ddl
            assert "CREATE" in sq_ddl and "INDEX" in sq_ddl


def test_orders_date_filter_utc_boundaries_and_combined_status(db_env):
    _, SessionLocal, client = db_env
    db = SessionLocal()
    try:
        mgr = models.User(username="manager", hashed_password="h", is_manager=True)
        latte = models.Product(name="Latte", price=4.5, stock=100)
        db.add_all([mgr, latte])
        db.commit()
        db.refresh(mgr)
        db.refresh(latte)

        timestamps_and_statuses = [
            ("prev_day_end", datetime(2026, 11, 17, 23, 59, 59, 999999), "pending"),
            ("day_start", datetime(2026, 11, 18, 0, 0, 0, 0), "pending"),
            ("day_mid_completed", datetime(2026, 11, 18, 12, 30, 0, 0), "completed"),
            ("day_end", datetime(2026, 11, 18, 23, 59, 59, 999999), "pending"),
            ("next_day_start", datetime(2026, 11, 19, 0, 0, 0, 0), "pending"),
            ("leap_day", datetime(2024, 2, 29, 23, 59, 59, 0), "completed"),
            ("after_leap_day", datetime(2024, 3, 1, 0, 0, 0, 0), "completed"),
        ]
        label_to_id = {}
        for label, ts, st in timestamps_and_statuses:
            order = models.Order(user_id=mgr.id, status=st, created_at=ts)
            db.add(order)
            db.flush()
            db.add(
                models.OrderItem(
                    order_id=order.id, product_id=latte.id, quantity=2
                )
            )
            label_to_id[label] = order.id
        db.commit()
    finally:
        db.close()

    headers = _auth_headers("manager")

    # 1. Date filter alone includes full 24h UTC window and excludes adjacent dates
    resp_date = client.get("/orders/?date_filter=2026-11-18", headers=headers)
    assert resp_date.status_code == 200
    returned_ids = {o["id"] for o in resp_date.json()}
    assert returned_ids == {
        label_to_id["day_start"],
        label_to_id["day_mid_completed"],
        label_to_id["day_end"],
    }

    # Verify OrderOut response schema preservation
    sample = resp_date.json()[0]
    assert set(sample.keys()) == {"id", "user_id", "status", "created_at", "items"}
    assert len(sample["items"]) == 1
    assert set(sample["items"][0].keys()) == {"id", "product_id", "quantity", "product"}
    assert set(sample["items"][0]["product"].keys()) == {"id", "name", "price", "stock"}

    # 2. Combined status + date_filter
    resp_combo = client.get(
        "/orders/?status=pending&date_filter=2026-11-18", headers=headers
    )
    assert resp_combo.status_code == 200
    assert {o["id"] for o in resp_combo.json()} == {
        label_to_id["day_start"],
        label_to_id["day_end"],
    }

    # 3. Status alone
    resp_status = client.get("/orders/?status=completed", headers=headers)
    assert resp_status.status_code == 200
    assert {o["id"] for o in resp_status.json()} == {
        label_to_id["day_mid_completed"],
        label_to_id["leap_day"],
        label_to_id["after_leap_day"],
    }

    # 4. Leap-day boundary rollover
    resp_leap = client.get("/orders/?date_filter=2024-02-29", headers=headers)
    assert resp_leap.status_code == 200
    assert {o["id"] for o in resp_leap.json()} == {label_to_id["leap_day"]}

    # 5. Invalid date format still returns 422
    resp_invalid = client.get("/orders/?date_filter=not-a-date", headers=headers)
    assert resp_invalid.status_code == 422


def test_explain_query_plan_uses_indexes_across_all_five_routers(db_env):
    engine, SessionLocal, _ = db_env
    db = SessionLocal()
    try:
        target_day = date(2026, 11, 18)
        start_dt = datetime.combine(target_day, time.min)
        next_day_dt = start_dt + timedelta(days=1)

        queries = {
            "dashboard_recent_orders": (
                db.query(models.Order)
                .order_by(models.Order.created_at.desc())
                .limit(10)
            ),
            "orders_by_status": (
                db.query(models.Order).filter(models.Order.status == "pending")
            ),
            "orders_by_date_range": (
                db.query(models.Order).filter(
                    models.Order.created_at >= start_dt,
                    models.Order.created_at < next_day_dt,
                )
            ),
            "orders_by_status_and_date_range": (
                db.query(models.Order).filter(
                    models.Order.status == "pending",
                    models.Order.created_at >= start_dt,
                    models.Order.created_at < next_day_dt,
                )
            ),
            "order_items_by_order_id": (
                db.query(models.OrderItem).filter(models.OrderItem.order_id == 1)
            ),
            "inventory_order_items_by_product_id": (
                db.query(models.OrderItem)
                .filter(models.OrderItem.product_id == 1)
                .limit(1)
            ),
            "reports_by_type": (
                db.query(models.SalesReport)
                .filter(models.SalesReport.report_type == "daily")
                .order_by(
                    models.SalesReport.created_at.desc(),
                    models.SalesReport.id.desc(),
                )
                .offset(0)
                .limit(21)
            ),
            "users_fk_orders_by_user_id": (
                db.query(models.Order.id).filter(models.Order.user_id == 1)
            ),
        }

        expected_index = {
            "dashboard_recent_orders": "ix_orders_created_at",
            "orders_by_status": "ix_orders_status_created_at",
            "orders_by_date_range": "ix_orders_created_at",
            "orders_by_status_and_date_range": "ix_orders_status_created_at",
            "order_items_by_order_id": "ix_order_items_order_id",
            "inventory_order_items_by_product_id": "ix_order_items_product_id",
            "reports_by_type": "ix_sales_reports_report_type_created_at",
            "users_fk_orders_by_user_id": "ix_orders_user_id",
        }

        with engine.connect() as conn:
            for name, orm_query in queries.items():
                compiled = orm_query.statement.compile(
                    dialect=sqlite.dialect(),
                    compile_kwargs={"literal_binds": True},
                )
                plan_rows = conn.execute(
                    text(f"EXPLAIN QUERY PLAN {compiled}")
                ).fetchall()
                details = " | ".join(str(row[-1]) for row in plan_rows)
                assert "USING INDEX" in details or "USING COVERING INDEX" in details, (
                    f"{name} did not use an index: {details}"
                )
                assert expected_index[name] in details, (
                    f"{name} expected {expected_index[name]}, got: {details}"
                )
                assert "TEMP B-TREE" not in details, (
                    f"{name} used a temporary sort tree: {details}"
                )
    finally:
        db.close()


def test_all_routers_preserve_contracts_and_foreign_keys(db_env):
    _, SessionLocal, client = db_env
    db = SessionLocal()
    try:
        mgr = models.User(
            username="mgr",
            hashed_password=auth.get_password_hash("pw"),
            is_manager=True,
        )
        staff_with_orders = models.User(
            username="busy_staff",
            hashed_password=auth.get_password_hash("pw"),
            is_manager=False,
        )
        staff_unused = models.User(
            username="former_staff",
            hashed_password=auth.get_password_hash("pw"),
            is_manager=False,
        )
        used_prod = models.Product(name="Espresso", price=3.0, stock=50)
        unused_prod = models.Product(name="Seasonal Syrup", price=1.5, stock=10)
        db.add_all([mgr, staff_with_orders, staff_unused, used_prod, unused_prod])
        db.commit()
        for obj in [mgr, staff_with_orders, staff_unused, used_prod, unused_prod]:
            db.refresh(obj)

        for i in range(12):
            o = models.Order(
                user_id=staff_with_orders.id,
                status="completed",
                created_at=datetime(2026, 11, 1, 8, 0, 0) + timedelta(hours=i),
            )
            db.add(o)
            db.flush()
            db.add(
                models.OrderItem(
                    order_id=o.id, product_id=used_prod.id, quantity=1
                )
            )

        db.add_all(
            [
                models.SalesReport(report_type="daily", total_sales=120.5),
                models.SalesReport(report_type="weekly", total_sales=840.0),
                models.SalesReport(report_type="monthly", total_sales=3600.0),
            ]
        )
        db.commit()
        used_prod_id = used_prod.id
        unused_prod_id = unused_prod.id
        staff_with_orders_id = staff_with_orders.id
        staff_unused_id = staff_unused.id
    finally:
        db.close()

    headers = _auth_headers("mgr")

    # Dashboard returns 10 most recent orders in descending created_at order
    dash = client.get("/dashboard/summary", headers=headers)
    assert dash.status_code == 200
    dash_data = dash.json()
    assert dash_data["totalSales"] == 0.0
    assert len(dash_data["recentOrders"]) == 10
    created_ats = [o["created_at"] for o in dash_data["recentOrders"]]
    assert created_ats == sorted(created_ats, reverse=True)

    # Reports return matching daily, weekly, and monthly records
    for rtype, expected_total in [
        ("daily", 120.5),
        ("weekly", 840.0),
        ("monthly", 3600.0),
    ]:
        rep = client.get(f"/reports/{rtype}", headers=headers)
        assert rep.status_code == 200
        assert rep.headers.get("X-Has-More") == "false"
        items = rep.json()
        assert len(items) == 1
        assert items[0]["report_type"] == rtype
        assert items[0]["total_sales"] == expected_total
        assert set(items[0].keys()) == {
            "id",
            "report_type",
            "total_sales",
            "created_at",
        }

    # Inventory blocks deleting products referenced by orders, allows deleting unused products
    del_used = client.delete(f"/inventory/{used_prod_id}", headers=headers)
    assert del_used.status_code == 400
    assert "existing orders" in del_used.json()["detail"]

    del_unused = client.delete(f"/inventory/{unused_prod_id}", headers=headers)
    assert del_unused.status_code == 200
    assert del_unused.json() == {"detail": "Product deleted"}

    # Users allows deleting staff with no orders, enforces FK when orders reference user
    del_staff_ok = client.delete(f"/users/{staff_unused_id}", headers=headers)
    assert del_staff_ok.status_code == 200
    assert del_staff_ok.json() == {"detail": "User deleted"}

    with pytest.raises(IntegrityError):
        client.delete(f"/users/{staff_with_orders_id}", headers=headers)


def test_reports_pagination_ordering_has_more_and_exact_multiples(db_env):
    engine, SessionLocal, client = db_env
    db = SessionLocal()
    try:
        mgr = models.User(
            username="reports_mgr",
            hashed_password=auth.get_password_hash("pw"),
            is_manager=True,
        )
        db.add(mgr)
        db.commit()
    finally:
        db.close()

    headers = _auth_headers("reports_mgr")

    # Empty tables return [] with X-Has-More: false
    for rtype in ("daily", "weekly", "monthly"):
        empty_resp = client.get(f"/reports/{rtype}", headers=headers)
        assert empty_resp.status_code == 200
        assert empty_resp.json() == []
        assert empty_resp.headers.get("X-Has-More") == "false"

    # Seed 45 daily reports (with duplicate created_at timestamps to test id DESC tie-breaking),
    # 20 weekly reports (exact multiple of default limit=20), and 5 monthly reports.
    base_dt = datetime(2026, 1, 1, 12, 0, 0)
    db = SessionLocal()
    try:
        expected_daily_ids = []
        daily_records = []
        for i in range(45):
            # Pair indices (42, 43) share the exact same created_at timestamp
            day_offset = 42 if i in (42, 43) else i
            rec = models.SalesReport(
                report_type="daily",
                total_sales=round(100.0 + i, 2),
                created_at=base_dt + timedelta(days=day_offset),
            )
            db.add(rec)
            db.flush()
            daily_records.append((rec.created_at, rec.id))

        expected_daily_ids = [
            rid
            for _dt, rid in sorted(
                daily_records, key=lambda pair: (pair[0], pair[1]), reverse=True
            )
        ]

        for i in range(20):
            db.add(
                models.SalesReport(
                    report_type="weekly",
                    total_sales=round(500.0 + i * 10, 2),
                    created_at=base_dt + timedelta(weeks=i),
                )
            )

        for i in range(5):
            db.add(
                models.SalesReport(
                    report_type="monthly",
                    total_sales=round(2000.0 + i * 100, 2),
                    created_at=base_dt + timedelta(days=30 * i),
                )
            )
        db.commit()

        # Verify EXPLAIN QUERY PLAN for paginated non-zero offset report queries across report types
        with engine.connect() as conn:
            for rtype in ("daily", "weekly", "monthly"):
                q = (
                    db.query(models.SalesReport)
                    .filter(models.SalesReport.report_type == rtype)
                    .order_by(
                        models.SalesReport.created_at.desc(),
                        models.SalesReport.id.desc(),
                    )
                    .offset(20)
                    .limit(21)
                )
                compiled = q.statement.compile(
                    dialect=sqlite.dialect(),
                    compile_kwargs={"literal_binds": True},
                )
                plan_rows = conn.execute(
                    text(f"EXPLAIN QUERY PLAN {compiled}")
                ).fetchall()
                details = " | ".join(str(row[-1]) for row in plan_rows)
                assert "ix_sales_reports_report_type_created_at" in details
                assert "TEMP B-TREE" not in details
    finally:
        db.close()

    # Daily page 1 (default limit=20, offset=0) -> 20 items, X-Has-More: true
    p1 = client.get("/reports/daily", headers=headers)
    assert p1.status_code == 200
    assert p1.headers.get("X-Has-More") == "true"
    p1_items = p1.json()
    assert len(p1_items) == 20
    assert [r["id"] for r in p1_items] == expected_daily_ids[:20]

    # Verify identical created_at tie-break orders higher id first
    tied_slice = [r for r in p1_items if r["created_at"].startswith("2026-02-12")]
    assert len(tied_slice) == 2
    assert tied_slice[0]["id"] > tied_slice[1]["id"]

    # Daily page 2 (limit=20, offset=20) -> 20 items, X-Has-More: true
    p2 = client.get("/reports/daily?limit=20&offset=20", headers=headers)
    assert p2.status_code == 200
    assert p2.headers.get("X-Has-More") == "true"
    p2_items = p2.json()
    assert len(p2_items) == 20
    assert [r["id"] for r in p2_items] == expected_daily_ids[20:40]

    # Daily page 3 (limit=20, offset=40) -> 5 items, X-Has-More: false
    p3 = client.get("/reports/daily?limit=20&offset=40", headers=headers)
    assert p3.status_code == 200
    assert p3.headers.get("X-Has-More") == "false"
    p3_items = p3.json()
    assert len(p3_items) == 5
    assert [r["id"] for r in p3_items] == expected_daily_ids[40:]

    # Exact multiple of limit (20 weekly rows with default limit=20) -> X-Has-More: false
    weekly_default = client.get("/reports/weekly", headers=headers)
    assert weekly_default.status_code == 200
    assert len(weekly_default.json()) == 20
    assert weekly_default.headers.get("X-Has-More") == "false"

    # Custom limit=5 across weekly rows
    weekly_slice = client.get("/reports/weekly?limit=5&offset=0", headers=headers)
    assert weekly_slice.status_code == 200
    assert len(weekly_slice.json()) == 5
    assert weekly_slice.headers.get("X-Has-More") == "true"

    weekly_last = client.get("/reports/weekly?limit=5&offset=15", headers=headers)
    assert weekly_last.status_code == 200
    assert len(weekly_last.json()) == 5
    assert weekly_last.headers.get("X-Has-More") == "false"

    # Monthly with max limit=100
    monthly_max = client.get("/reports/monthly?limit=100&offset=0", headers=headers)
    assert monthly_max.status_code == 200
    assert len(monthly_max.json()) == 5
    assert monthly_max.headers.get("X-Has-More") == "false"


def test_reports_pagination_bounds_return_422(db_env):
    _, SessionLocal, client = db_env
    db = SessionLocal()
    try:
        mgr = models.User(
            username="bounds_mgr",
            hashed_password=auth.get_password_hash("pw"),
            is_manager=True,
        )
        db.add(mgr)
        db.commit()
    finally:
        db.close()

    headers = _auth_headers("bounds_mgr")

    for rtype in ("daily", "weekly", "monthly"):
        for invalid_query in (
            "limit=0",
            "limit=-1",
            "limit=101",
            "offset=-1",
        ):
            resp = client.get(f"/reports/{rtype}?{invalid_query}", headers=headers)
            assert resp.status_code == 422, (
                f"Expected 422 for /reports/{rtype}?{invalid_query}, got {resp.status_code}"
            )
