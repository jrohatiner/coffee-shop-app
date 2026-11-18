import os
import tempfile
from datetime import date, datetime, time, timedelta

# Point app.database at an isolated temp SQLite database during test module import
_IMPORT_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_IMPORT_DB.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_IMPORT_DB.name}"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect, text
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

    Base.metadata.create_all(bind=engine)
    ensure_indexes(bind_engine=engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    try:
        yield engine, TestingSessionLocal, client
    finally:
        app.dependency_overrides.clear()
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

    # Startup ensure_indexes creates all missing indexes and is idempotent on repeat runs
    ensure_indexes(bind_engine=legacy_engine)
    ensure_indexes(bind_engine=legacy_engine)

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
                db.query(models.SalesReport).filter(
                    models.SalesReport.report_type == "daily"
                )
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
