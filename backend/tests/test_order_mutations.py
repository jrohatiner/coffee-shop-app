import os
import re
import sys
from pathlib import Path
from typing import List, Tuple
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Ensure backend root is importable and DATABASE_URL is valid before importing app modules
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://user:pass@localhost:5432/test_db")

from app import auth, models  # noqa: E402
from app.database import Base, get_db  # noqa: E402
from app.routers import orders as orders_router  # noqa: E402


SELECT_PRODUCTS_RE = re.compile(r"^\s*SELECT\b.*\bFROM\s+products\b", re.IGNORECASE | re.DOTALL)


class QueryTracker:
    def __init__(self) -> None:
        self.statements: List[str] = []
        self.pg_statements: List[str] = []
        self.commits: int = 0

    def reset(self) -> None:
        self.statements.clear()
        self.pg_statements.clear()
        self.commits = 0

    @property
    def product_selects(self) -> List[str]:
        return [stmt for stmt in self.statements if SELECT_PRODUCTS_RE.match(stmt)]

    @property
    def pg_product_selects(self) -> List[str]:
        return [stmt for stmt in self.pg_statements if SELECT_PRODUCTS_RE.match(stmt)]


@pytest.fixture()
def test_env(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(
        autocommit=False,
        autoflush=False,
        expire_on_commit=True,
        bind=engine,
    )
    Base.metadata.create_all(bind=engine)

    tracker = QueryTracker()

    @event.listens_for(engine, "before_cursor_execute")
    def _on_execute(conn, cursor, statement, parameters, context, executemany):
        tracker.statements.append(statement)

    @event.listens_for(TestingSessionLocal, "do_orm_execute")
    def _on_orm_execute(orm_execute_state):
        if orm_execute_state.is_select:
            compiled = str(orm_execute_state.statement.compile(dialect=postgresql.dialect()))
            tracker.pg_statements.append(compiled)

    @event.listens_for(TestingSessionLocal, "after_commit")
    def _on_commit(session):
        tracker.commits += 1

    # Seed user and 15 distinct products
    seed_db = TestingSessionLocal()
    user = models.User(id=1, username="barista", hashed_password="hashed", is_manager=False)
    products = [
        models.Product(name=f"Coffee #{i}", price=3.50 + i * 0.25, stock=20)
        for i in range(1, 16)
    ]
    seed_db.add(user)
    seed_db.add_all(products)
    seed_db.commit()
    user_id = user.id
    product_ids = [p.id for p in products]
    seed_db.close()

    emit_events: List[Tuple[str, Tuple, dict]] = []

    async def _fake_emit(event_name: str, *args, **kwargs):
        # Verify emit occurs only after transaction changes are committed
        check_db = TestingSessionLocal()
        try:
            emit_events.append(
                (
                    event_name,
                    args,
                    {
                        "commits_so_far": tracker.commits,
                        "order_count": check_db.query(models.Order).count(),
                    },
                )
            )
        finally:
            check_db.close()

    emit_mock = AsyncMock(side_effect=_fake_emit)
    monkeypatch.setattr(orders_router.sio, "emit", emit_mock)

    app = FastAPI()
    app.include_router(orders_router.router, prefix="/orders")

    def _override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    def _override_current_user():
        return models.User(id=user_id, username="barista", is_manager=False)

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[auth.get_current_user] = _override_current_user

    client = TestClient(app)
    tracker.reset()

    yield {
        "client": client,
        "SessionLocal": TestingSessionLocal,
        "tracker": tracker,
        "product_ids": product_ids,
        "emit_mock": emit_mock,
        "emit_events": emit_events,
    }

    Base.metadata.drop_all(bind=engine)
    engine.dispose()


def test_multi_item_create_and_cancel_batch_product_queries_and_single_commit(test_env):
    client: TestClient = test_env["client"]
    tracker: QueryTracker = test_env["tracker"]
    product_ids: List[int] = test_env["product_ids"]
    emit_events = test_env["emit_events"]
    SessionLocal = test_env["SessionLocal"]

    # Checkout a 15-item order
    tracker.reset()
    emit_events.clear()
    payload = {
        "status": "pending",
        "items": [{"product_id": pid, "quantity": 2} for pid in product_ids],
    }
    resp = client.post("/orders/", json=payload)
    assert resp.status_code == 200, resp.text

    data = resp.json()
    assert data["status"] == "pending"
    assert data["user_id"] == 1
    assert len(data["items"]) == 15
    assert [it["product"]["stock"] for it in data["items"]] == [18] * 15
    assert len(tracker.product_selects) == 1
    assert "FOR UPDATE" in tracker.pg_product_selects[0]
    assert tracker.commits == 1
    assert [ev[0] for ev in emit_events] == ["new_order", "stock_update"]
    assert all(ev[2]["commits_so_far"] == 1 and ev[2]["order_count"] == 1 for ev in emit_events)

    # Cancel the 15-item order
    order_id = data["id"]
    tracker.reset()
    emit_events.clear()
    cancel_resp = client.post(f"/orders/{order_id}/cancel")
    assert cancel_resp.status_code == 200, cancel_resp.text

    cancelled = cancel_resp.json()
    assert cancelled["id"] == order_id
    assert cancelled["status"] == "cancelled"
    assert len(cancelled["items"]) == 15
    assert [it["product"]["stock"] for it in cancelled["items"]] == [20] * 15
    assert len(tracker.product_selects) == 1
    assert "FOR UPDATE" in tracker.pg_product_selects[0]
    assert tracker.commits == 1
    assert [ev[0] for ev in emit_events] == ["stock_update", "order_cancelled"]
    assert emit_events[1][1] == (
        {
            "id": order_id,
            "status": "cancelled",
            "created_at": cancelled["created_at"],
            "order_id": order_id,
        },
    )
    assert all(ev[2]["commits_so_far"] == 1 for ev in emit_events)

    db = SessionLocal()
    try:
        stocks = [
            p.stock
            for p in db.query(models.Product).order_by(models.Product.id).all()
        ]
        assert stocks == [20] * 15
    finally:
        db.close()


@pytest.mark.parametrize("item_count", [1, 5, 15])
def test_constant_product_select_count_across_cart_sizes(test_env, item_count):
    client: TestClient = test_env["client"]
    tracker: QueryTracker = test_env["tracker"]
    product_ids: List[int] = test_env["product_ids"][:item_count]

    tracker.reset()
    create_resp = client.post(
        "/orders/",
        json={"items": [{"product_id": pid, "quantity": 1} for pid in product_ids]},
    )
    assert create_resp.status_code == 200
    assert len(tracker.product_selects) == 1
    assert tracker.commits == 1

    order_id = create_resp.json()["id"]
    tracker.reset()
    cancel_resp = client.post(f"/orders/{order_id}/cancel")
    assert cancel_resp.status_code == 200
    assert len(tracker.product_selects) == 1
    assert tracker.commits == 1


def test_http_400_failures_leave_zero_orphan_orders_and_unchanged_stock(test_env):
    client: TestClient = test_env["client"]
    tracker: QueryTracker = test_env["tracker"]
    product_ids: List[int] = test_env["product_ids"]
    emit_events = test_env["emit_events"]
    SessionLocal = test_env["SessionLocal"]

    # 1. Missing product ID
    tracker.reset()
    emit_events.clear()
    r_missing = client.post(
        "/orders/",
        json={
            "items": [
                {"product_id": product_ids[0], "quantity": 1},
                {"product_id": 99999, "quantity": 1},
            ]
        },
    )
    assert r_missing.status_code == 400
    assert r_missing.json()["detail"] == "Product 99999 does not exist"
    assert tracker.commits == 0
    assert emit_events == []

    # 2. Non-positive quantity
    tracker.reset()
    r_zero = client.post(
        "/orders/",
        json={
            "items": [
                {"product_id": product_ids[0], "quantity": 2},
                {"product_id": product_ids[1], "quantity": 0},
            ]
        },
    )
    assert r_zero.status_code == 400
    assert r_zero.json()["detail"] == "Invalid quantity for product Coffee #2"
    assert tracker.commits == 0
    assert emit_events == []

    # 3. Insufficient stock on multi-item order
    tracker.reset()
    r_insufficient = client.post(
        "/orders/",
        json={
            "items": [
                {"product_id": product_ids[0], "quantity": 5},
                {"product_id": product_ids[1], "quantity": 25},
            ]
        },
    )
    assert r_insufficient.status_code == 400
    assert (
        r_insufficient.json()["detail"]
        == "Insufficient stock for Coffee #2. Available: 20, requested: 25"
    )
    assert tracker.commits == 0
    assert emit_events == []

    db = SessionLocal()
    try:
        assert db.query(models.Order).count() == 0
        assert db.query(models.OrderItem).count() == 0
        stocks = [p.stock for p in db.query(models.Product).order_by(models.Product.id).all()]
        assert stocks == [20] * 15
    finally:
        db.close()


def test_duplicate_product_ids_aggregate_for_validation_deduction_and_restock(test_env):
    client: TestClient = test_env["client"]
    tracker: QueryTracker = test_env["tracker"]
    pid = test_env["product_ids"][0]
    SessionLocal = test_env["SessionLocal"]

    # Split items (12 + 10 = 22 > 20 stock) must be rejected before persistence
    tracker.reset()
    bad_resp = client.post(
        "/orders/",
        json={
            "items": [
                {"product_id": pid, "quantity": 12},
                {"product_id": pid, "quantity": 10},
            ]
        },
    )
    assert bad_resp.status_code == 400
    assert (
        bad_resp.json()["detail"]
        == "Insufficient stock for Coffee #1. Available: 20, requested: 22"
    )
    assert len(tracker.product_selects) == 1
    assert tracker.commits == 0

    db = SessionLocal()
    try:
        assert db.query(models.Order).count() == 0
        assert db.query(models.Product).filter(models.Product.id == pid).one().stock == 20
    finally:
        db.close()

    # Valid split items (7 + 8 = 15 <= 20 stock) deduct 15 and restock 15 on cancel
    tracker.reset()
    ok_resp = client.post(
        "/orders/",
        json={
            "items": [
                {"product_id": pid, "quantity": 7},
                {"product_id": pid, "quantity": 8},
            ]
        },
    )
    assert ok_resp.status_code == 200
    order_data = ok_resp.json()
    assert len(order_data["items"]) == 2
    assert [it["product"]["stock"] for it in order_data["items"]] == [5, 5]
    assert len(tracker.product_selects) == 1
    assert tracker.commits == 1

    tracker.reset()
    cancel_resp = client.post(f"/orders/{order_data['id']}/cancel")
    assert cancel_resp.status_code == 200
    cancelled_data = cancel_resp.json()
    assert [it["product"]["stock"] for it in cancelled_data["items"]] == [20, 20]
    assert len(tracker.product_selects) == 1
    assert tracker.commits == 1


def test_empty_items_and_idempotent_cancel_and_missing_product_restock(test_env):
    client: TestClient = test_env["client"]
    tracker: QueryTracker = test_env["tracker"]
    p1, p2 = test_env["product_ids"][:2]
    emit_events = test_env["emit_events"]
    SessionLocal = test_env["SessionLocal"]

    # Empty items order skips Product IN () query completely
    tracker.reset()
    empty_resp = client.post("/orders/", json={"items": []})
    assert empty_resp.status_code == 200
    empty_order = empty_resp.json()
    assert empty_order["items"] == []
    assert len(tracker.product_selects) == 0
    assert tracker.commits == 1

    # Cancelling an empty order also skips Product IN () query
    tracker.reset()
    empty_cancel = client.post(f"/orders/{empty_order['id']}/cancel")
    assert empty_cancel.status_code == 200
    assert empty_cancel.json()["status"] == "cancelled"
    assert len(tracker.product_selects) == 0
    assert tracker.commits == 1

    # Create 2-item order, cancel once, then verify second cancel returns early without double restock
    create_resp = client.post(
        "/orders/",
        json={
            "items": [
                {"product_id": p1, "quantity": 3},
                {"product_id": p2, "quantity": 4},
            ]
        },
    )
    assert create_resp.status_code == 200
    oid = create_resp.json()["id"]

    first_cancel = client.post(f"/orders/{oid}/cancel")
    assert first_cancel.status_code == 200

    tracker.reset()
    emit_events.clear()
    second_cancel = client.post(f"/orders/{oid}/cancel")
    assert second_cancel.status_code == 200
    second_data = second_cancel.json()
    assert second_data["status"] == "cancelled"
    assert [it["product"]["stock"] for it in second_data["items"]] == [20, 20]
    assert len(tracker.product_selects) == 1
    assert "FOR UPDATE" not in tracker.pg_product_selects[0]
    assert tracker.commits == 0
    assert emit_events == []

    # Create another 2-item order, delete one Product row, and verify cancel safely restocks remaining product
    create_resp2 = client.post(
        "/orders/",
        json={
            "items": [
                {"product_id": p1, "quantity": 5},
                {"product_id": p2, "quantity": 6},
            ]
        },
    )
    assert create_resp2.status_code == 200
    oid2 = create_resp2.json()["id"]

    db = SessionLocal()
    try:
        db.query(models.Product).filter(models.Product.id == p2).delete()
        db.commit()
    finally:
        db.close()

    tracker.reset()
    emit_events.clear()
    partial_cancel = client.post(f"/orders/{oid2}/cancel")
    assert partial_cancel.status_code == 200
    partial_data = partial_cancel.json()
    assert partial_data["status"] == "cancelled"
    assert len(tracker.product_selects) == 1
    assert tracker.commits == 1
    assert [ev[0] for ev in emit_events] == ["stock_update", "order_cancelled"]

    db = SessionLocal()
    try:
        assert db.query(models.Product).filter(models.Product.id == p1).one().stock == 20
    finally:
        db.close()

    # Non-existent order returns 404
    not_found = client.post("/orders/999999/cancel")
    assert not_found.status_code == 404
    assert not_found.json()["detail"] == "Order not found"
