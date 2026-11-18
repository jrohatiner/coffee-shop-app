import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-for-orders-suite")
os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

test_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

from app import auth, models
from app.database import get_db
from app.main import app
from app.routers.orders import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture()
def setup_db():
    had_prev = get_db in app.dependency_overrides
    prev_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db
    models.Base.metadata.drop_all(bind=test_engine)
    models.Base.metadata.create_all(bind=test_engine)
    try:
        yield
    finally:
        models.Base.metadata.drop_all(bind=test_engine)
        if had_prev:
            app.dependency_overrides[get_db] = prev_override
        else:
            app.dependency_overrides.pop(get_db, None)


@pytest.fixture()
def client(setup_db):
    return TestClient(app)


@pytest.fixture()
def auth_headers(setup_db):
    db = TestingSessionLocal()
    try:
        user = models.User(
            username="staff",
            hashed_password=auth.get_password_hash("staff123"),
            is_manager=False,
        )
        db.add(user)
        db.commit()
    finally:
        db.close()
    token = auth.create_access_token({"sub": "staff"})
    return {"Authorization": f"Bearer {token}"}


def _seed_orders(n_orders: int, n_products: int = 25, items_per_order: int = 3):
    db = TestingSessionLocal()
    try:
        user = db.query(models.User).filter(models.User.username == "staff").first()
        products = [
            models.Product(name=f"Product-{i}", price=3.5 + (i % 5) * 0.5, stock=5000)
            for i in range(n_products)
        ]
        db.add_all(products)
        db.commit()
        for p in products:
            db.refresh(p)

        base_time = datetime(2026, 11, 18, 8, 0, 0)
        for i in range(n_orders):
            order = models.Order(
                user_id=user.id,
                status="pending" if i % 2 == 0 else "completed",
                created_at=base_time + timedelta(minutes=i),
            )
            db.add(order)
            db.flush()
            for j in range(items_per_order):
                prod = products[(i + j) % n_products]
                db.add(
                    models.OrderItem(
                        order_id=order.id,
                        product_id=prod.id,
                        quantity=j + 1,
                    )
                )
        db.commit()
    finally:
        db.close()


class QueryCounter:
    def __init__(self, engine):
        self.engine = engine
        self.statements = []

    def _callback(self, conn, cursor, statement, parameters, context, executemany):
        self.statements.append(statement)

    def __enter__(self):
        self.statements.clear()
        event.listen(self.engine, "before_cursor_execute", self._callback)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        event.remove(self.engine, "before_cursor_execute", self._callback)

    @property
    def count(self) -> int:
        return len(self.statements)


def _assert_order_schema(order_json: dict):
    assert set(order_json.keys()) == {"id", "user_id", "status", "created_at", "items"}
    assert isinstance(order_json["items"], list)
    for item in order_json["items"]:
        assert set(item.keys()) == {"id", "product_id", "quantity", "product"}
        assert set(item["product"].keys()) == {"id", "name", "price", "stock"}


def test_list_orders_constant_query_count_across_dataset_sizes(auth_headers):
    counts = []
    for n_orders in (50, 200, 500):
        models.Base.metadata.drop_all(bind=test_engine)
        models.Base.metadata.create_all(bind=test_engine)
        db = TestingSessionLocal()
        db.add(
            models.User(
                username="staff",
                hashed_password=auth.get_password_hash("staff123"),
                is_manager=False,
            )
        )
        db.commit()
        db.close()

        _seed_orders(n_orders=n_orders, n_products=25, items_per_order=3)
        test_client = TestClient(app)

        with QueryCounter(test_engine) as qc:
            res = test_client.get("/orders/", headers=auth_headers)

        assert res.status_code == 200
        body = res.json()
        assert len(body) == DEFAULT_PAGE_SIZE
        _assert_order_schema(body[0])
        counts.append(qc.count)

    assert len(set(counts)) == 1, f"Expected constant query count across N=(50,200,500), got {counts}"
    assert counts[0] <= 4


def test_single_order_get_and_put_constant_query_count_across_item_counts(auth_headers):
    get_counts = []
    put_counts = []

    for k_items in (1, 4, 8):
        models.Base.metadata.drop_all(bind=test_engine)
        models.Base.metadata.create_all(bind=test_engine)
        db = TestingSessionLocal()
        user = models.User(
            username="staff",
            hashed_password=auth.get_password_hash("staff123"),
            is_manager=False,
        )
        db.add(user)
        products = [
            models.Product(name=f"Item-{i}", price=2.5 + i, stock=100)
            for i in range(10)
        ]
        db.add_all(products)
        db.commit()
        db.refresh(user)
        for p in products:
            db.refresh(p)

        order = models.Order(user_id=user.id, status="pending")
        db.add(order)
        db.flush()
        for j in range(k_items):
            db.add(
                models.OrderItem(
                    order_id=order.id,
                    product_id=products[j].id,
                    quantity=j + 1,
                )
            )
        db.commit()
        order_id = order.id
        db.close()

        test_client = TestClient(app)

        with QueryCounter(test_engine) as qc_get:
            res_get = test_client.get(f"/orders/{order_id}", headers=auth_headers)
        assert res_get.status_code == 200
        get_data = res_get.json()
        assert len(get_data["items"]) == k_items
        _assert_order_schema(get_data)
        get_counts.append(qc_get.count)

        with QueryCounter(test_engine) as qc_put:
            res_put = test_client.put(
                f"/orders/{order_id}",
                params={"status": "in_progress"},
                headers=auth_headers,
            )
        assert res_put.status_code == 200
        put_data = res_put.json()
        assert put_data["status"] == "in_progress"
        assert len(put_data["items"]) == k_items
        _assert_order_schema(put_data)
        put_counts.append(qc_put.count)

    assert len(set(get_counts)) == 1, f"Expected constant GET query count across K=(1,4,8), got {get_counts}"
    assert len(set(put_counts)) == 1, f"Expected constant PUT query count across K=(1,4,8), got {put_counts}"


def test_default_limit_and_newest_first_ordering(client, auth_headers):
    _seed_orders(n_orders=45, n_products=5, items_per_order=2)

    res = client.get("/orders/", headers=auth_headers)
    assert res.status_code == 200
    assert res.headers.get("x-has-more") == "true"

    data = res.json()
    assert len(data) == DEFAULT_PAGE_SIZE
    timestamps = [row["created_at"] for row in data]
    assert timestamps == sorted(timestamps, reverse=True)
    # Newest seeded order has id 45
    assert data[0]["id"] == 45


def test_pagination_pages_traverse_all_records_without_overlap(client, auth_headers):
    _seed_orders(n_orders=25, n_products=5, items_per_order=2)

    p1 = client.get("/orders/", params={"limit": 10, "offset": 0}, headers=auth_headers)
    p2 = client.get("/orders/", params={"limit": 10, "offset": 10}, headers=auth_headers)
    p3 = client.get("/orders/", params={"limit": 10, "offset": 20}, headers=auth_headers)

    assert p1.status_code == 200 and p1.headers.get("x-has-more") == "true"
    assert p2.status_code == 200 and p2.headers.get("x-has-more") == "true"
    assert p3.status_code == 200 and p3.headers.get("x-has-more") == "false"

    ids_1 = [o["id"] for o in p1.json()]
    ids_2 = [o["id"] for o in p2.json()]
    ids_3 = [o["id"] for o in p3.json()]

    assert len(ids_1) == 10
    assert len(ids_2) == 10
    assert len(ids_3) == 5
    combined = ids_1 + ids_2 + ids_3
    assert combined == list(range(25, 0, -1))


def test_exact_multiple_page_size_sets_has_more_false_on_last_page(client, auth_headers):
    _seed_orders(n_orders=20, n_products=4, items_per_order=2)

    p1 = client.get("/orders/", params={"limit": 10, "offset": 0}, headers=auth_headers)
    p2 = client.get("/orders/", params={"limit": 10, "offset": 10}, headers=auth_headers)

    assert p1.headers.get("x-has-more") == "true"
    assert p2.headers.get("x-has-more") == "false"
    assert len(p2.json()) == 10


def test_pagination_validation_rejects_negative_offset_and_excessive_limit(client, auth_headers):
    neg_offset = client.get("/orders/", params={"offset": -1}, headers=auth_headers)
    assert neg_offset.status_code == 422

    zero_limit = client.get("/orders/", params={"limit": 0}, headers=auth_headers)
    assert zero_limit.status_code == 422

    over_max = client.get("/orders/", params={"limit": MAX_PAGE_SIZE + 1}, headers=auth_headers)
    assert over_max.status_code == 422

    at_max = client.get("/orders/", params={"limit": MAX_PAGE_SIZE}, headers=auth_headers)
    assert at_max.status_code == 200


def test_status_and_date_filters_with_pagination(client, auth_headers):
    db = TestingSessionLocal()
    try:
        user = db.query(models.User).filter(models.User.username == "staff").first()
        prod = models.Product(name="Latte", price=4.5, stock=100)
        db.add(prod)
        db.commit()
        db.refresh(prod)

        day_one = datetime(2026, 11, 17, 14, 30, 0)
        day_two = datetime(2026, 11, 18, 9, 15, 0)

        for idx, (dt, st) in enumerate(
            [
                (day_one, "pending"),
                (day_one + timedelta(hours=1), "completed"),
                (day_two, "pending"),
                (day_two + timedelta(hours=1), "pending"),
                (day_two + timedelta(hours=2), "cancelled"),
            ]
        ):
            o = models.Order(user_id=user.id, status=st, created_at=dt)
            db.add(o)
            db.flush()
            db.add(models.OrderItem(order_id=o.id, product_id=prod.id, quantity=idx + 1))
        db.commit()
    finally:
        db.close()

    res = client.get(
        "/orders",
        params={"status": "pending", "date_filter": "2026-11-18", "limit": 1, "offset": 0},
        headers=auth_headers,
    )
    assert res.status_code == 200
    assert res.headers.get("x-has-more") == "true"
    page_1 = res.json()
    assert len(page_1) == 1
    assert page_1[0]["status"] == "pending"
    assert page_1[0]["created_at"].startswith("2026-11-18")

    res_2 = client.get(
        "/orders",
        params={"status": "pending", "date_filter": "2026-11-18", "limit": 1, "offset": 1},
        headers=auth_headers,
    )
    assert res_2.status_code == 200
    assert res_2.headers.get("x-has-more") == "false"
    page_2 = res_2.json()
    assert len(page_2) == 1
    assert page_2[0]["id"] != page_1[0]["id"]


def test_create_cancel_update_get_preserve_schema_and_auth(client, auth_headers):
    # Auth required across endpoints
    assert client.get("/orders/").status_code == 401
    assert client.get("/orders/1").status_code == 401
    assert client.put("/orders/1", params={"status": "completed"}).status_code == 401
    assert client.post("/orders/", json={"status": "pending", "items": []}).status_code == 401
    assert client.post("/orders/1/cancel").status_code == 401

    db = TestingSessionLocal()
    p1 = models.Product(name="Espresso", price=3.0, stock=10)
    p2 = models.Product(name="Mocha", price=4.8, stock=5)
    db.add_all([p1, p2])
    db.commit()
    db.refresh(p1)
    db.refresh(p2)
    p1_id, p2_id = p1.id, p2.id
    db.close()

    created = client.post(
        "/orders",
        json={
            "status": "pending",
            "items": [
                {"product_id": p1_id, "quantity": 2},
                {"product_id": p2_id, "quantity": 1},
            ],
        },
        headers=auth_headers,
    )
    assert created.status_code == 200
    created_json = created.json()
    _assert_order_schema(created_json)
    order_id = created_json["id"]

    fetched = client.get(f"/orders/{order_id}", headers=auth_headers)
    assert fetched.status_code == 200
    _assert_order_schema(fetched.json())
    assert {it["product"]["name"] for it in fetched.json()["items"]} == {"Espresso", "Mocha"}

    updated = client.put(f"/orders/{order_id}", params={"status": "in_progress"}, headers=auth_headers)
    assert updated.status_code == 200
    _assert_order_schema(updated.json())
    assert updated.json()["status"] == "in_progress"

    cancelled = client.post(f"/orders/{order_id}/cancel", headers=auth_headers)
    assert cancelled.status_code == 200
    _assert_order_schema(cancelled.json())
    assert cancelled.json()["status"] == "cancelled"
    # Stock restored
    stocks = {it["product"]["name"]: it["product"]["stock"] for it in cancelled.json()["items"]}
    assert stocks == {"Espresso": 10, "Mocha": 5}
