import json
import os
import statistics
import time
from datetime import datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient
from pydantic import TypeAdapter
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://user:pass@localhost:5432/coffee")

from app import auth, models, schemas  # noqa: E402
from app.database import get_db  # noqa: E402
from app.routers import inventory as inventory_router  # noqa: E402
from app.routers import orders as orders_router  # noqa: E402
from app.websockets import init_websockets, sio  # noqa: E402


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
    resp = client.get("/ws/?EIO=4&transport=polling")
    assert resp.status_code == 200
    assert '"sid"' in resp.text
