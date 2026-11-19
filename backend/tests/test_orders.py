import os
import statistics
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import TypeAdapter
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Ensure `app` package is importable whether pytest is run from repo root or backend/
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_BOOTSTRAP_DB_FD, _BOOTSTRAP_DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_BOOTSTRAP_DB_FD)
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_BOOTSTRAP_DB_PATH}")
os.environ.setdefault("JWT_SECRET", "super-secret-test-key-for-order-tests")

from app import auth, models, schemas  # noqa: E402
from app.database import Base, get_db  # noqa: E402
from app.main import app as main_app  # noqa: E402
from app.routers import inventory as inventory_router  # noqa: E402
from app.routers import orders as orders_router  # noqa: E402
from app.websockets import init_websockets, sio  # noqa: E402

_TEST_PASSWORD_HASH = auth.get_password_hash("testpass123")


@pytest.fixture(scope="session", autouse=True)
def cleanup_bootstrap_db():
    yield
    if os.path.exists(_BOOTSTRAP_DB_PATH):
        os.remove(_BOOTSTRAP_DB_PATH)


@pytest.fixture()
def test_context(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    db = TestingSessionLocal()
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

    def override_get_db():
        s = TestingSessionLocal()
        try:
            yield s
        finally:
            s.close()

    app = FastAPI()
    app.include_router(orders_router.router, prefix="/orders")
    app.include_router(inventory_router.router, prefix="/inventory")
    init_websockets(app)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[auth.get_current_user] = lambda: staff

    emit_mock = AsyncMock()
    monkeypatch.setattr(sio, "emit", emit_mock)

    client = TestClient(app)
    try:
        yield {
            "client": client,
            "SessionLocal": TestingSessionLocal,
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
    assert [r["id"] for r in by_date.json()] == [o2.id, o3.id]

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

    resp = client.get("/orders/")
    assert resp.status_code == 200
    assert len(resp.json()) == 1000
    assert len(resp.content) < 80_000


def test_socketio_mount_handshake_succeeds(test_context):
    client = test_context["client"]
    resp = client.get("/ws/socket.io/?EIO=4&transport=polling")
    assert resp.status_code == 200
    assert '"sid"' in resp.text


@pytest.fixture()
def db_session(tmp_path):
    db_file = tmp_path / "test_orders.db"
    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client(db_session):
    def override_get_db():
        yield db_session

    previous_override = main_app.dependency_overrides.get(get_db)
    main_app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(main_app) as test_client:
            yield test_client
    finally:
        if previous_override is not None:
            main_app.dependency_overrides[get_db] = previous_override
        else:
            main_app.dependency_overrides.pop(get_db, None)


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
