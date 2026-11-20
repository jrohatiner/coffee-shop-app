import os
import statistics
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

# Ensure `app` package is importable whether pytest is run from repo root or backend/
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_BOOTSTRAP_DB_FD, _BOOTSTRAP_DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_BOOTSTRAP_DB_FD)
_TEST_DB_FD, _TEST_DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_TEST_DB_FD)

os.environ.setdefault("DATABASE_URL", f"sqlite:///{_BOOTSTRAP_DB_PATH}")
os.environ.setdefault("JWT_SECRET", "super-secret-test-key-for-order-tests")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import TypeAdapter  # noqa: E402
from sqlalchemy import create_engine, event  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

test_engine = create_engine(
    f"sqlite:///{_TEST_DB_PATH}",
    connect_args={"check_same_thread": False},
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

from app import auth, models, schemas  # noqa: E402
from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import inventory as inventory_router  # noqa: E402
from app.routers import orders as orders_router  # noqa: E402
from app.routers.orders import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE  # noqa: E402
from app.websockets import init_websockets, sio  # noqa: E402

_TEST_PASSWORD_HASH = auth.get_password_hash("testpass123")


@pytest.fixture(scope="session", autouse=True)
def cleanup_bootstrap_db():
    yield
    test_engine.dispose()
    for path in (_BOOTSTRAP_DB_PATH, _TEST_DB_PATH):
        if os.path.exists(path):
            os.remove(path)


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture()
def test_context(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(bind=engine)
    LocalSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    db = LocalSession()
    staff = models.User(
        username="staff",
        hashed_password=auth.get_password_hash("staff123"),
        is_manager=False,
    )
    espresso = models.Product(name="Espresso", price=3.0, stock=100)
    latte = models.Product(name="Latte", price=4.5, stock=80)
    db.add_all([staff, espresso, latte])
    db.commit()
    db.refresh(staff)
    db.refresh(espresso)
    db.refresh(latte)

    def local_override_get_db():
        s = LocalSession()
        try:
            yield s
        finally:
            s.close()

    local_app = FastAPI()
    local_app.include_router(orders_router.router, prefix="/orders")
    local_app.include_router(inventory_router.router, prefix="/inventory")
    init_websockets(local_app)
    local_app.dependency_overrides[get_db] = local_override_get_db
    local_app.dependency_overrides[auth.get_current_user] = lambda: staff

    emit_mock = AsyncMock()
    monkeypatch.setattr(sio, "emit", emit_mock)

    test_client = TestClient(local_app)
    try:
        yield {
            "client": test_client,
            "SessionLocal": LocalSession,
            "user": staff,
            "products": {"espresso": espresso, "latte": latte},
            "emit_mock": emit_mock,
        }
    finally:
        db.close()
        models.Base.metadata.drop_all(bind=engine)


def test_list_orders_returns_lightweight_summaries_only(test_context):
    client = test_context["client"]
    espresso = test_context["products"]["espresso"]
    latte = test_context["products"]["latte"]

    create_resp = client.post(
        "/orders/",
        json={
            "status": "pending",
            "items": [
                {"product_id": espresso.id, "quantity": 2},
                {"product_id": latte.id, "quantity": 1},
            ],
        },
    )
    assert create_resp.status_code == 200

    list_resp = client.get("/orders/")
    assert list_resp.status_code == 200
    rows = list_resp.json()
    assert len(rows) == 1
    row = rows[0]
    assert set(row.keys()) == {"id", "status", "created_at"}
    assert "items" not in row
    assert "product" not in row
    assert "user_id" not in row
    assert row["status"] == "pending"


def test_list_orders_supports_status_and_date_filters(test_context):
    client = test_context["client"]
    SessionLocal = test_context["SessionLocal"]
    user = test_context["user"]

    db = SessionLocal()
    try:
        o1 = models.Order(
            user_id=user.id,
            status="pending",
            created_at=datetime(2026, 11, 17, 9, 30, 0),
        )
        o2 = models.Order(
            user_id=user.id,
            status="completed",
            created_at=datetime(2026, 11, 18, 14, 15, 0),
        )
        o3 = models.Order(
            user_id=user.id,
            status="cancelled",
            created_at=datetime(2026, 11, 18, 18, 45, 0),
        )
        db.add_all([o1, o2, o3])
        db.commit()
        db.refresh(o1)
        db.refresh(o2)
        db.refresh(o3)
    finally:
        db.close()

    by_status = client.get("/orders/", params={"status": "completed"})
    assert by_status.status_code == 200
    assert [r["id"] for r in by_status.json()] == [o2.id]

    by_date = client.get("/orders/", params={"date_filter": "2026-11-18"})
    assert by_date.status_code == 200
    assert [r["id"] for r in by_date.json()] == [o3.id, o2.id]

    by_both = client.get(
        "/orders/",
        params={"status": "cancelled", "date_filter": "2026-11-18"},
    )
    assert by_both.status_code == 200
    assert [r["id"] for r in by_both.json()] == [o3.id]


def test_get_order_returns_full_details_and_404_when_missing(test_context):
    client = test_context["client"]
    espresso = test_context["products"]["espresso"]
    latte = test_context["products"]["latte"]

    created = client.post(
        "/orders/",
        json={
            "status": "in_progress",
            "items": [
                {"product_id": espresso.id, "quantity": 3},
                {"product_id": latte.id, "quantity": 1},
            ],
        },
    ).json()

    detail_resp = client.get(f"/orders/{created['id']}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["id"] == created["id"]
    assert detail["status"] == "in_progress"
    assert detail["user_id"] == test_context["user"].id
    assert len(detail["items"]) == 2
    assert {(it["product"]["name"], it["quantity"]) for it in detail["items"]} == {
        ("Espresso", 3),
        ("Latte", 1),
    }

    missing_resp = client.get("/orders/999999")
    assert missing_resp.status_code == 404


def test_create_and_cancel_emit_summary_events_and_update_stock(test_context):
    client = test_context["client"]
    emit_mock = test_context["emit_mock"]
    espresso = test_context["products"]["espresso"]

    create_resp = client.post(
        "/orders/",
        json={
            "status": "pending",
            "items": [{"product_id": espresso.id, "quantity": 4}],
        },
    )
    assert create_resp.status_code == 200
    created = create_resp.json()
    assert len(created["items"]) == 1
    assert created["items"][0]["product"]["name"] == "Espresso"

    # Inventory stock decreased by 4
    inv_after_create = client.get("/inventory/").json()
    esp_after_create = next(p for p in inv_after_create if p["id"] == espresso.id)
    assert esp_after_create["stock"] == 96

    # Check emitted Socket.IO events on create
    create_events = [(call.args[0], call.args[1] if len(call.args) > 1 else None) for call in emit_mock.call_args_list]
    assert ("stock_update", None) in create_events
    new_order_payloads = [payload for event, payload in create_events if event == "new_order"]
    assert len(new_order_payloads) == 1
    assert new_order_payloads[0] == {
        "id": created["id"],
        "status": "pending",
        "created_at": created["created_at"],
    }

    emit_mock.reset_mock()

    cancel_resp = client.post(f"/orders/{created['id']}/cancel")
    assert cancel_resp.status_code == 200
    cancelled = cancel_resp.json()
    assert cancelled["status"] == "cancelled"
    assert len(cancelled["items"]) == 1

    # Inventory stock restored to 100
    inv_after_cancel = client.get("/inventory/").json()
    esp_after_cancel = next(p for p in inv_after_cancel if p["id"] == espresso.id)
    assert esp_after_cancel["stock"] == 100

    # Check emitted Socket.IO events on cancel
    cancel_events = [(call.args[0], call.args[1] if len(call.args) > 1 else None) for call in emit_mock.call_args_list]
    assert ("stock_update", None) in cancel_events
    cancelled_payloads = [payload for event, payload in cancel_events if event == "order_cancelled"]
    assert len(cancelled_payloads) == 1
    assert cancelled_payloads[0]["id"] == created["id"]
    assert cancelled_payloads[0]["order_id"] == created["id"]
    assert cancelled_payloads[0]["status"] == "cancelled"
    assert cancelled_payloads[0]["created_at"] == created["created_at"]


def test_thousand_orders_payload_size_and_serialization_speed(test_context):
    client = test_context["client"]
    SessionLocal = test_context["SessionLocal"]
    user = test_context["user"]
    espresso = test_context["products"]["espresso"]
    latte = test_context["products"]["latte"]

    db = SessionLocal()
    try:
        ts = datetime(2026, 11, 18, 12, 0, 0, 123456)
        orders = [
            models.Order(user_id=user.id, status="pending", created_at=ts)
            for _ in range(1000)
        ]
        db.add_all(orders)
        db.commit()
        items = []
        for idx, order in enumerate(orders):
            items.append(
                models.OrderItem(
                    order_id=order.id,
                    product_id=espresso.id if idx % 2 == 0 else latte.id,
                    quantity=2,
                )
            )
            items.append(
                models.OrderItem(
                    order_id=order.id,
                    product_id=latte.id if idx % 2 == 0 else espresso.id,
                    quantity=1,
                )
            )
        db.add_all(items)
        db.commit()

        rows = db.query(models.Order.id, models.Order.status, models.Order.created_at).all()
        adapter = TypeAdapter(list[schemas.OrderSummaryOut])
        durations_ms = []
        for _ in range(9):
            start = time.perf_counter()
            validated = adapter.validate_python(rows, from_attributes=True)
            serialized = adapter.dump_json(validated)
            durations_ms.append((time.perf_counter() - start) * 1000)

        median_ms = statistics.median(durations_ms)
        assert median_ms < 10.0, f"Expected median serialization < 10ms, got {median_ms:.2f}ms"
        assert len(serialized) < 80_000
    finally:
        db.close()

    resp = client.get("/orders/", params={"limit": MAX_PAGE_SIZE})
    assert resp.status_code == 200
    assert resp.headers.get("x-has-more") == "true"
    assert len(resp.json()) == MAX_PAGE_SIZE
    assert len(resp.content) < 8_000


def test_socketio_mount_handshake_succeeds(test_context):
    client = test_context["client"]
    resp = client.get("/ws/socket.io/?EIO=4&transport=polling")
    assert resp.status_code == 200
    assert '"sid"' in resp.text


@pytest.fixture()
def setup_db():
    had_prev = get_db in app.dependency_overrides
    prev_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db
    Base.metadata.drop_all(bind=test_engine)
    Base.metadata.create_all(bind=test_engine)
    try:
        yield
    finally:
        Base.metadata.drop_all(bind=test_engine)
        test_engine.dispose()
        if had_prev:
            app.dependency_overrides[get_db] = prev_override
        else:
            app.dependency_overrides.pop(get_db, None)


@pytest.fixture()
def db_session(setup_db):
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(setup_db):
    with patch("app.routers.orders.sio.emit", new_callable=AsyncMock):
        with TestClient(app) as test_client:
            yield test_client


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


def _assert_order_summary_schema(order_json: dict):
    assert set(order_json.keys()) == {"id", "status", "created_at"}


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
        _assert_order_summary_schema(body[0])
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


def _create_user(db_session, username: str, is_manager: bool = False) -> models.User:
    user = models.User(
        username=username,
        hashed_password=_TEST_PASSWORD_HASH,
        is_manager=is_manager,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _auth_headers(user: models.User) -> dict:
    token = auth.create_access_token({"sub": user.username})
    return {"Authorization": f"Bearer {token}"}


def _create_product(
    db_session, name: str = "Espresso", price: float = 3.0, stock: int = 10
) -> models.Product:
    product = models.Product(name=name, price=price, stock=stock)
    db_session.add(product)
    db_session.commit()
    db_session.refresh(product)
    return product


def _create_order(
    db_session,
    user: models.User,
    product: models.Product,
    quantity: int = 2,
    status: str = "pending",
) -> models.Order:
    order = models.Order(user_id=user.id, status=status)
    db_session.add(order)
    db_session.commit()
    db_session.refresh(order)

    product.stock -= quantity
    item = models.OrderItem(
        order_id=order.id,
        product_id=product.id,
        quantity=quantity,
    )
    db_session.add(item)
    db_session.commit()
    db_session.refresh(order)
    db_session.refresh(product)
    return order


@pytest.fixture()
def seeded_data(db_session):
    owner = models.User(
        username="owner_user",
        hashed_password=_TEST_PASSWORD_HASH,
        is_manager=False,
    )
    other_staff = models.User(
        username="other_staff",
        hashed_password=_TEST_PASSWORD_HASH,
        is_manager=False,
    )
    manager = models.User(
        username="store_manager",
        hashed_password=_TEST_PASSWORD_HASH,
        is_manager=True,
    )
    product = models.Product(name="Espresso", price=3.0, stock=50)
    db_session.add_all([owner, other_staff, manager, product])
    db_session.commit()
    db_session.refresh(owner)
    db_session.refresh(other_staff)
    db_session.refresh(manager)
    db_session.refresh(product)

    order = models.Order(user_id=owner.id, status="pending")
    db_session.add(order)
    db_session.commit()
    db_session.refresh(order)

    item = models.OrderItem(order_id=order.id, product_id=product.id, quantity=2)
    db_session.add(item)
    db_session.commit()
    db_session.refresh(order)

    return {
        "owner": owner,
        "other_staff": other_staff,
        "manager": manager,
        "order": order,
        "owner_headers": {
            "Authorization": f"Bearer {auth.create_access_token({'sub': owner.username})}"
        },
        "other_staff_headers": {
            "Authorization": f"Bearer {auth.create_access_token({'sub': other_staff.username})}"
        },
        "manager_headers": {
            "Authorization": f"Bearer {auth.create_access_token({'sub': manager.username})}"
        },
    }


def test_cancel_order_non_owner_forbidden(client, db_session):
    owner = _create_user(db_session, "customer_one", is_manager=False)
    other_user = _create_user(db_session, "staff_two", is_manager=False)
    product = _create_product(db_session, stock=10)
    order = _create_order(db_session, owner, product, quantity=3, status="pending")
    assert product.stock == 7

    res = client.post(
        f"/orders/{order.id}/cancel",
        headers=_auth_headers(other_user),
    )

    assert res.status_code == 403
    assert res.json()["detail"] == "Not authorized to cancel this order"

    db_session.refresh(order)
    db_session.refresh(product)
    assert order.status == "pending"
    assert product.stock == 7


def test_cancel_order_owner_succeeds_and_restocks(client, db_session):
    owner = _create_user(db_session, "customer_owner", is_manager=False)
    product = _create_product(db_session, stock=10)
    order = _create_order(db_session, owner, product, quantity=4, status="pending")
    assert product.stock == 6

    res = client.post(
        f"/orders/{order.id}/cancel",
        headers=_auth_headers(owner),
    )

    assert res.status_code == 200
    assert res.json()["status"] == "cancelled"

    db_session.refresh(order)
    db_session.refresh(product)
    assert order.status == "cancelled"
    assert product.stock == 10


def test_cancel_order_manager_can_cancel_other_user_order(client, db_session):
    owner = _create_user(db_session, "customer_a", is_manager=False)
    manager = _create_user(db_session, "manager_user", is_manager=True)
    product = _create_product(db_session, stock=15)
    order = _create_order(db_session, owner, product, quantity=5, status="pending")
    assert product.stock == 10

    res = client.post(
        f"/orders/{order.id}/cancel",
        headers=_auth_headers(manager),
    )

    assert res.status_code == 200
    assert res.json()["status"] == "cancelled"

    db_session.refresh(order)
    db_session.refresh(product)
    assert order.status == "cancelled"
    assert product.stock == 15


@pytest.mark.parametrize("terminal_status", ["completed", "shipped"])
def test_cancel_order_rejects_completed_or_shipped(client, db_session, terminal_status):
    owner = _create_user(db_session, f"owner_{terminal_status}", is_manager=False)
    manager = _create_user(db_session, f"manager_{terminal_status}", is_manager=True)
    product = _create_product(db_session, name=f"Latte_{terminal_status}", stock=10)
    order = _create_order(
        db_session, owner, product, quantity=2, status=terminal_status
    )
    assert product.stock == 8

    for caller in (owner, manager):
        res = client.post(
            f"/orders/{order.id}/cancel",
            headers=_auth_headers(caller),
        )
        assert res.status_code == 400
        assert res.json()["detail"] == "Cannot cancel order in current status"

    db_session.refresh(order)
    db_session.refresh(product)
    assert order.status == terminal_status
    assert product.stock == 8


def test_cancel_order_non_owner_on_completed_or_cancelled_still_returns_403(
    client, db_session
):
    owner = _create_user(db_session, "owner_u", is_manager=False)
    non_owner = _create_user(db_session, "other_u", is_manager=False)
    product = _create_product(db_session, stock=10)
    completed_order = _create_order(
        db_session, owner, product, quantity=1, status="completed"
    )
    cancelled_order = _create_order(
        db_session, owner, product, quantity=1, status="cancelled"
    )

    for target in (completed_order, cancelled_order):
        res = client.post(
            f"/orders/{target.id}/cancel",
            headers=_auth_headers(non_owner),
        )
        assert res.status_code == 403
        assert res.json()["detail"] == "Not authorized to cancel this order"


def test_cancel_order_non_existent_returns_404_before_auth_check(client, db_session):
    non_manager = _create_user(db_session, "regular_staff", is_manager=False)

    res = client.post(
        "/orders/99999/cancel",
        headers=_auth_headers(non_manager),
    )

    assert res.status_code == 404
    assert res.json()["detail"] == "Order not found"


def test_cancel_order_already_cancelled_is_idempotent_without_double_restock(
    client, db_session
):
    owner = _create_user(db_session, "idempotent_owner", is_manager=False)
    product = _create_product(db_session, stock=10)
    order = _create_order(db_session, owner, product, quantity=3, status="pending")
    assert product.stock == 7

    first = client.post(
        f"/orders/{order.id}/cancel",
        headers=_auth_headers(owner),
    )
    assert first.status_code == 200
    db_session.refresh(product)
    assert product.stock == 10

    second = client.post(
        f"/orders/{order.id}/cancel",
        headers=_auth_headers(owner),
    )
    assert second.status_code == 200
    assert second.json()["status"] == "cancelled"
    db_session.refresh(product)
    assert product.stock == 10


def test_cancel_order_unauthenticated_returns_401(client):
    res = client.post("/orders/1/cancel")
    assert res.status_code == 401


def test_non_owner_non_manager_cannot_update_other_users_order(client, db_session, seeded_data):
    order_id = seeded_data["order"].id

    resp = client.put(
        f"/orders/{order_id}",
        params={"status": "completed"},
        headers=seeded_data["other_staff_headers"],
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Not authorized to update this order"

    db_session.expire_all()
    persisted = db_session.query(models.Order).filter_by(id=order_id).first()
    assert persisted.status == "pending"


def test_non_owner_non_manager_tampered_status_returns_403(client, db_session, seeded_data):
    order_id = seeded_data["order"].id

    resp = client.put(
        f"/orders/{order_id}",
        params={"status": "tampered"},
        headers=seeded_data["other_staff_headers"],
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Not authorized to update this order"

    db_session.expire_all()
    persisted = db_session.query(models.Order).filter_by(id=order_id).first()
    assert persisted.status == "pending"


@pytest.mark.parametrize("valid_status", ["in_progress", "completed", "cancelled", "pending"])
def test_order_owner_can_update_own_order_status(client, db_session, seeded_data, valid_status):
    order_id = seeded_data["order"].id

    resp = client.put(
        f"/orders/{order_id}",
        params={"status": valid_status},
        headers=seeded_data["owner_headers"],
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == valid_status

    db_session.expire_all()
    persisted = db_session.query(models.Order).filter_by(id=order_id).first()
    assert persisted.status == valid_status


@pytest.mark.parametrize("valid_status", ["in_progress", "completed", "cancelled", "pending"])
def test_manager_can_update_any_users_order_status(client, db_session, seeded_data, valid_status):
    order_id = seeded_data["order"].id

    resp = client.put(
        f"/orders/{order_id}",
        params={"status": valid_status},
        headers=seeded_data["manager_headers"],
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == valid_status

    db_session.expire_all()
    persisted = db_session.query(models.Order).filter_by(id=order_id).first()
    assert persisted.status == valid_status


def test_non_existent_order_returns_404_before_auth_and_status_checks(client, seeded_data):
    for headers in (
        seeded_data["other_staff_headers"],
        seeded_data["owner_headers"],
        seeded_data["manager_headers"],
    ):
        resp = client.put(
            "/orders/999999",
            params={"status": "tampered"},
            headers=headers,
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Order not found"


@pytest.mark.parametrize(
    "invalid_status",
    [
        "tampered",
        "",
        "COMPLETED",
        " pending",
        "completed ",
        "approved",
        "completed; DROP TABLE orders;",
    ],
)
def test_invalid_status_rejected_with_400_for_authorized_users(
    client, db_session, seeded_data, invalid_status
):
    order_id = seeded_data["order"].id

    for headers in (seeded_data["owner_headers"], seeded_data["manager_headers"]):
        resp = client.put(
            f"/orders/{order_id}",
            params={"status": invalid_status},
            headers=headers,
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid order status"

    db_session.expire_all()
    persisted = db_session.query(models.Order).filter_by(id=order_id).first()
    assert persisted.status == "pending"


def test_orphaned_order_requires_manager(client, db_session, seeded_data):
    orphan_order = models.Order(user_id=None, status="pending")
    db_session.add(orphan_order)
    db_session.commit()
    db_session.refresh(orphan_order)

    forbidden_resp = client.put(
        f"/orders/{orphan_order.id}",
        params={"status": "completed"},
        headers=seeded_data["other_staff_headers"],
    )
    assert forbidden_resp.status_code == 403

    manager_resp = client.put(
        f"/orders/{orphan_order.id}",
        params={"status": "completed"},
        headers=seeded_data["manager_headers"],
    )
    assert manager_resp.status_code == 200
    assert manager_resp.json()["status"] == "completed"


def test_unauthenticated_order_update_returns_401(client, seeded_data):
    order_id = seeded_data["order"].id
    resp = client.put(f"/orders/{order_id}", params={"status": "completed"})
    assert resp.status_code == 401


def test_list_orders_non_manager_receives_only_own_orders(client, db_session):
    staff_a = _create_user(db_session, "staff_alice", is_manager=False)
    staff_b = _create_user(db_session, "staff_bob", is_manager=False)
    manager = _create_user(db_session, "manager_carol", is_manager=True)
    product = _create_product(db_session, stock=100)

    order_a1 = _create_order(db_session, staff_a, product, quantity=1, status="pending")
    order_b1 = _create_order(db_session, staff_b, product, quantity=2, status="completed")
    order_mgr = _create_order(db_session, manager, product, quantity=1, status="in_progress")
    order_a2 = _create_order(db_session, staff_a, product, quantity=3, status="completed")

    orphan_order = models.Order(user_id=None, status="pending")
    db_session.add(orphan_order)
    db_session.commit()
    db_session.refresh(orphan_order)

    # Non-manager staff_a sees only their own orders (both /orders/ and /orders)
    for path in ("/orders/", "/orders"):
        resp_a = client.get(path, headers=_auth_headers(staff_a))
        assert resp_a.status_code == 200
        ids_a = [o["id"] for o in resp_a.json()]
        assert set(ids_a) == {order_a1.id, order_a2.id}
        assert order_b1.id not in ids_a
        assert order_mgr.id not in ids_a
        assert orphan_order.id not in ids_a

    # Non-manager staff_b sees only their own order
    resp_b = client.get("/orders/", headers=_auth_headers(staff_b))
    assert resp_b.status_code == 200
    assert [o["id"] for o in resp_b.json()] == [order_b1.id]

    # Manager retains visibility across all orders, including orphaned ones
    resp_mgr = client.get("/orders/", headers=_auth_headers(manager))
    assert resp_mgr.status_code == 200
    ids_mgr = {o["id"] for o in resp_mgr.json()}
    assert ids_mgr == {
        order_a1.id,
        order_a2.id,
        order_b1.id,
        order_mgr.id,
        orphan_order.id,
    }


def test_list_orders_zero_orders_account_returns_empty_array(client, db_session):
    empty_user = _create_user(db_session, "new_customer", is_manager=False)
    other_user = _create_user(db_session, "active_customer", is_manager=False)
    manager = _create_user(db_session, "active_manager", is_manager=True)
    product = _create_product(db_session, stock=50)

    _create_order(db_session, other_user, product, quantity=1, status="pending")
    _create_order(db_session, manager, product, quantity=2, status="completed")

    resp = client.get("/orders/", headers=_auth_headers(empty_user))
    assert resp.status_code == 200
    assert resp.json() == []
    assert resp.headers.get("x-has-more") == "false"


def test_list_orders_preserves_status_date_and_pagination_for_non_managers_and_managers(
    client, db_session
):
    staff_a = _create_user(db_session, "filter_staff_a", is_manager=False)
    staff_b = _create_user(db_session, "filter_staff_b", is_manager=False)
    manager = _create_user(db_session, "filter_manager", is_manager=True)

    day_1 = datetime(2026, 11, 17, 10, 0, 0)
    day_2 = datetime(2026, 11, 18, 15, 0, 0)

    records = [
        ("a_d1_pending", staff_a.id, "pending", day_1),
        ("a_d2_pending", staff_a.id, "pending", day_2),
        ("a_d2_completed", staff_a.id, "completed", day_2 + timedelta(minutes=5)),
        ("b_d2_pending", staff_b.id, "pending", day_2 + timedelta(minutes=10)),
        ("mgr_d2_pending", manager.id, "pending", day_2 + timedelta(minutes=15)),
    ]
    by_label = {}
    for label, uid, st, ts in records:
        order = models.Order(user_id=uid, status=st, created_at=ts)
        db_session.add(order)
        db_session.flush()
        by_label[label] = order.id
    db_session.commit()

    # Non-manager filtering by status only sees own matching orders
    resp_a_pending = client.get(
        "/orders/",
        params={"status": "pending"},
        headers=_auth_headers(staff_a),
    )
    assert resp_a_pending.status_code == 200
    assert [o["id"] for o in resp_a_pending.json()] == [
        by_label["a_d2_pending"],
        by_label["a_d1_pending"],
    ]
    assert resp_a_pending.headers.get("x-has-more") == "false"

    # Non-manager filtering by date_filter only sees own orders on that date
    resp_a_day2 = client.get(
        "/orders/",
        params={"date_filter": "2026-11-18"},
        headers=_auth_headers(staff_a),
    )
    assert resp_a_day2.status_code == 200
    assert [o["id"] for o in resp_a_day2.json()] == [
        by_label["a_d2_completed"],
        by_label["a_d2_pending"],
    ]

    # Non-manager combined status + date_filter + limit=1 does not count other users' orders in X-Has-More
    resp_a_combo = client.get(
        "/orders/",
        params={"status": "pending", "date_filter": "2026-11-18", "limit": 1},
        headers=_auth_headers(staff_a),
    )
    assert resp_a_combo.status_code == 200
    assert [o["id"] for o in resp_a_combo.json()] == [by_label["a_d2_pending"]]
    assert resp_a_combo.headers.get("x-has-more") == "false"

    # Manager combined status + date_filter sees all users' matching orders and accurate X-Has-More
    resp_mgr_combo = client.get(
        "/orders/",
        params={"status": "pending", "date_filter": "2026-11-18", "limit": 2},
        headers=_auth_headers(manager),
    )
    assert resp_mgr_combo.status_code == 200
    assert [o["id"] for o in resp_mgr_combo.json()] == [
        by_label["mgr_d2_pending"],
        by_label["b_d2_pending"],
    ]
    assert resp_mgr_combo.headers.get("x-has-more") == "true"

