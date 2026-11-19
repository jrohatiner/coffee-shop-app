import asyncio
import inspect
import os
import threading
import time
from typing import Any, List, Tuple

import httpx
import pytest
from fastapi.routing import APIRoute
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

# Ensure module-level create_engine() and JWT config have valid defaults on import
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("JWT_SECRET", "super-secret-test-key-for-concurrency-tests")

from app import auth, database, models  # noqa: E402
from app.main import app  # noqa: E402
from app.websockets import sio  # noqa: E402


def _iter_api_routes(routes):
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
        elif hasattr(route, "original_router"):
            yield from _iter_api_routes(route.original_router.routes)
        elif hasattr(route, "routes") and getattr(route, "path", None) != "/ws":
            yield from _iter_api_routes(route.routes)


def _run_async(coro):
    return asyncio.run(coro)


@pytest.fixture()
def pooled_db(tmp_path, monkeypatch):
    """Bind app.database to a QueuePool(5, 10) SQLite database matching production pool limits."""
    db_file = tmp_path / "coffee_test.db"
    test_engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False, "timeout": 30.0},
        poolclass=QueuePool,
        pool_size=5,
        max_overflow=10,
        pool_timeout=1.5,
    )

    @event.listens_for(test_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()

    TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)
    monkeypatch.setattr(database, "engine", test_engine)
    monkeypatch.setattr(database, "SessionLocal", TestSessionLocal)

    models.Base.metadata.create_all(bind=test_engine)

    # Seed manager, staff, and sample products
    db = TestSessionLocal()
    try:
        manager = models.User(
            username="manager",
            hashed_password=auth.get_password_hash("manager123"),
            is_manager=True,
        )
        staff = models.User(
            username="staff",
            hashed_password=auth.get_password_hash("staff123"),
            is_manager=False,
        )
        db.add_all([manager, staff])
        for idx in range(1, 16):
            db.add(
                models.Product(
                    name=f"Coffee {idx}",
                    price=3.0 + idx * 0.25,
                    stock=100,
                )
            )
        db.commit()
    finally:
        db.close()

    try:
        yield test_engine, TestSessionLocal
    finally:
        test_engine.dispose()


def _auth_headers(username: str = "manager") -> dict:
    token = auth.create_access_token({"sub": username})
    return {"Authorization": f"Bearer {token}"}


def test_async_routes_execute_zero_sql_on_main_thread_and_hold_zero_pool_connections_in_emit(
    pooled_db, monkeypatch
):
    """
    Acceptance criteria:
    - All 5 async mutation routes execute 0 SQL statements on MainThread.
    - Checked-out QueuePool connections equal 0 when each route enters await sio.emit.
    - Every async APIRoute registered on the FastAPI app is covered by this check.
    """
    test_engine, _ = pooled_db
    headers = _auth_headers("manager")

    async_route_names = {
        route.endpoint.__name__
        for route in _iter_api_routes(app.routes)
        if inspect.iscoroutinefunction(route.endpoint)
    }
    assert async_route_names == {
        "create_order",
        "cancel_order",
        "create_inventory_item",
        "update_inventory",
        "delete_inventory_item",
    }

    sql_threads: List[Tuple[str, str]] = []
    emit_pool_snapshots: List[Tuple[str, Any, int]] = []

    def _before_cursor_execute(_conn, _cursor, statement, _params, _context, _executemany):
        sql_threads.append((threading.current_thread().name, statement))

    event.listen(test_engine, "before_cursor_execute", _before_cursor_execute)

    async def _recording_emit(event_name: str, data: Any = None, *args, **kwargs):
        emit_pool_snapshots.append((event_name, data, test_engine.pool.checkedout()))

    monkeypatch.setattr(sio, "emit", _recording_emit)

    async def _exercise_all_five_routes():
        assert threading.current_thread().name == "MainThread"
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            # 1. POST /inventory/ (create_inventory_item)
            sql_threads.clear()
            emit_pool_snapshots.clear()
            resp = await client.post(
                "/inventory/",
                json={"name": "Cold Brew", "price": 4.75, "stock": 40},
                headers=headers,
            )
            assert resp.status_code == 201
            created_product = resp.json()
            assert created_product["name"] == "Cold Brew"
            assert created_product["price"] == 4.75
            assert created_product["stock"] == 40
            assert len(sql_threads) > 0
            assert [stmt for thread_name, stmt in sql_threads if thread_name == "MainThread"] == []
            assert emit_pool_snapshots == [("stock_update", None, 0)]

            # 2. PUT /inventory/{product_id} (update_inventory)
            sql_threads.clear()
            emit_pool_snapshots.clear()
            resp = await client.put(
                f"/inventory/{created_product['id']}",
                json={"name": "Nitro Cold Brew", "price": 5.25, "stock": 35},
                headers=headers,
            )
            assert resp.status_code == 200
            updated_product = resp.json()
            assert updated_product == {
                "id": created_product["id"],
                "name": "Nitro Cold Brew",
                "price": 5.25,
                "stock": 35,
            }
            assert len(sql_threads) > 0
            assert [stmt for thread_name, stmt in sql_threads if thread_name == "MainThread"] == []
            assert emit_pool_snapshots == [("stock_update", None, 0)]

            # 3. POST /orders/ (create_order)
            sql_threads.clear()
            emit_pool_snapshots.clear()
            resp = await client.post(
                "/orders/",
                json={
                    "status": "pending",
                    "items": [
                        {"product_id": 1, "quantity": 2},
                        {"product_id": 2, "quantity": 3},
                    ],
                },
                headers=headers,
            )
            assert resp.status_code == 200
            created_order = resp.json()
            assert created_order["status"] == "pending"
            assert len(created_order["items"]) == 2
            assert created_order["items"][0]["product"]["id"] == 1
            assert created_order["items"][0]["product"]["stock"] == 98
            assert created_order["items"][1]["product"]["id"] == 2
            assert created_order["items"][1]["product"]["stock"] == 97
            assert len(sql_threads) > 0
            assert [stmt for thread_name, stmt in sql_threads if thread_name == "MainThread"] == []
            assert emit_pool_snapshots == [
                ("new_order", None, 0),
                ("stock_update", None, 0),
            ]

            # 4. POST /orders/{order_id}/cancel (cancel_order)
            sql_threads.clear()
            emit_pool_snapshots.clear()
            resp = await client.post(
                f"/orders/{created_order['id']}/cancel",
                headers=headers,
            )
            assert resp.status_code == 200
            cancelled_order = resp.json()
            assert cancelled_order["status"] == "cancelled"
            assert cancelled_order["items"][0]["product"]["stock"] == 100
            assert cancelled_order["items"][1]["product"]["stock"] == 100
            assert len(sql_threads) > 0
            assert [stmt for thread_name, stmt in sql_threads if thread_name == "MainThread"] == []
            assert emit_pool_snapshots == [
                ("stock_update", None, 0),
                ("order_cancelled", {"order_id": created_order["id"]}, 0),
            ]

            # 5. DELETE /inventory/{product_id} (delete_inventory_item)
            sql_threads.clear()
            emit_pool_snapshots.clear()
            resp = await client.delete(
                f"/inventory/{created_product['id']}",
                headers=headers,
            )
            assert resp.status_code == 200
            assert resp.json() == {"detail": "Product deleted"}
            assert len(sql_threads) > 0
            assert [stmt for thread_name, stmt in sql_threads if thread_name == "MainThread"] == []
            assert emit_pool_snapshots == [("stock_update", None, 0)]

    try:
        _run_async(_exercise_all_five_routes())
    finally:
        event.remove(test_engine, "before_cursor_execute", _before_cursor_execute)


def test_15_concurrent_inventory_updates_paused_in_emit_do_not_block_16th_get_inventory(
    pooled_db, monkeypatch
):
    """
    Acceptance criterion:
    Under 15 concurrent PUT /inventory/{product_id} calls paused in await sio.emit,
    QueuePool checked-out count is 0 and a 16th GET /inventory/ request succeeds
    immediately without waiting on broadcasts.
    """
    test_engine, _ = pooled_db
    headers = _auth_headers("manager")

    async def _run():
        in_emit = 0
        all_15_paused = asyncio.Event()
        release_broadcasts = asyncio.Event()
        checked_out_during_emit: List[int] = []

        async def _paused_emit(event_name: str, data: Any = None, *args, **kwargs):
            nonlocal in_emit
            in_emit += 1
            # Completed transactions that have reached sio.emit hold 0 connections;
            # only the remaining (15 - in_emit) still-running worker transactions may hold one.
            checked_out_during_emit.append((in_emit, test_engine.pool.checkedout()))
            if in_emit == 15:
                all_15_paused.set()
            await release_broadcasts.wait()

        monkeypatch.setattr(sio, "emit", _paused_emit)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            put_tasks = [
                asyncio.create_task(
                    client.put(
                        f"/inventory/{product_id}",
                        json={
                            "name": f"Updated Coffee {product_id}",
                            "price": 4.5,
                            "stock": 50 + product_id,
                        },
                        headers=headers,
                    )
                )
                for product_id in range(1, 16)
            ]

            await asyncio.wait_for(all_15_paused.wait(), timeout=5.0)

            # All 15 PUT calls are currently suspended inside await sio.emit
            assert all(not task.done() for task in put_tasks)
            assert test_engine.pool.checkedout() == 0
            assert all(
                checked_out <= 15 - completed_count
                for completed_count, checked_out in checked_out_during_emit
            )
            assert checked_out_during_emit[-1] == (15, 0)

            # 16th concurrent GET /inventory/ must succeed without waiting on release_broadcasts
            start = time.perf_counter()
            get_resp = await asyncio.wait_for(
                client.get("/inventory/", headers=headers),
                timeout=1.0,
            )
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            assert get_resp.status_code == 200
            products = get_resp.json()
            assert len(products) == 15
            assert {p["name"] for p in products} == {
                f"Updated Coffee {pid}" for pid in range(1, 16)
            }
            assert elapsed_ms < 250.0
            # Confirm broadcasts are still paused when GET succeeded
            assert all(not task.done() for task in put_tasks)

            release_broadcasts.set()
            put_responses = await asyncio.gather(*put_tasks)
            assert all(r.status_code == 200 for r in put_responses)

    _run_async(_run())


def test_event_loop_stays_responsive_during_concurrent_orders_with_query_latency(
    pooled_db, monkeypatch
):
    """
    Success metric check:
    Under 4 concurrent POST /orders/ calls with 3 ms per-query SQL latency,
    concurrent GET /openapi.json responds rapidly without blocking on worker SQL.
    """
    test_engine, _ = pooled_db
    headers = _auth_headers("staff")

    async def _noop_emit(*args, **kwargs):
        return None

    monkeypatch.setattr(sio, "emit", _noop_emit)

    def _slow_query(_conn, _cursor, _statement, _params, _context, _executemany):
        # Simulate 3 ms blocking DB cursor latency on whichever thread runs SQL
        assert threading.current_thread().name != "MainThread"
        time.sleep(0.003)

    event.listen(test_engine, "before_cursor_execute", _slow_query)

    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            # Warm up OpenAPI schema cache so we measure pure event-loop responsiveness
            warmup = await client.get("/openapi.json")
            assert warmup.status_code == 200

            order_tasks = [
                asyncio.create_task(
                    client.post(
                        "/orders/",
                        json={
                            "status": "pending",
                            "items": [
                                {"product_id": 1, "quantity": 1},
                                {"product_id": 2, "quantity": 1},
                                {"product_id": 3, "quantity": 1},
                            ],
                        },
                        headers=headers,
                    )
                )
                for _ in range(4)
            ]

            await asyncio.sleep(0.005)
            t0 = time.perf_counter()
            openapi_resp = await client.get("/openapi.json")
            openapi_ms = (time.perf_counter() - t0) * 1000.0
            assert openapi_resp.status_code == 200
            assert openapi_ms < 50.0

            order_resps = await asyncio.gather(*order_tasks)
            assert all(r.status_code == 200 for r in order_resps)

    try:
        _run_async(_run())
    finally:
        event.remove(test_engine, "before_cursor_execute", _slow_query)


def test_validation_errors_and_idempotency_preserve_messages_and_emit_no_events(
    pooled_db, monkeypatch
):
    """
    Requirement 5 & Acceptance criterion 4:
    Failed validations return exact status codes and error messages without emitting live events
    or leaking pooled connections, and cancelling an already-cancelled order is idempotent.
    """
    test_engine, _ = pooled_db
    headers = _auth_headers("manager")
    emitted: List[Tuple[str, Any]] = []

    async def _record_emit(event_name: str, data: Any = None, *args, **kwargs):
        emitted.append((event_name, data))

    monkeypatch.setattr(sio, "emit", _record_emit)

    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            # Missing product in order
            resp = await client.post(
                "/orders/",
                json={"status": "pending", "items": [{"product_id": 9999, "quantity": 1}]},
                headers=headers,
            )
            assert resp.status_code == 400
            assert resp.json()["detail"] == "Product 9999 does not exist"
            assert emitted == []

            # Invalid quantity (<= 0)
            resp = await client.post(
                "/orders/",
                json={"status": "pending", "items": [{"product_id": 1, "quantity": 0}]},
                headers=headers,
            )
            assert resp.status_code == 400
            assert resp.json()["detail"] == "Invalid quantity for product Coffee 1"
            assert emitted == []

            # Insufficient stock
            resp = await client.post(
                "/orders/",
                json={"status": "pending", "items": [{"product_id": 1, "quantity": 500}]},
                headers=headers,
            )
            assert resp.status_code == 400
            assert (
                resp.json()["detail"]
                == "Insufficient stock for Coffee 1. Available: 100, requested: 500"
            )
            assert emitted == []

            # Ensure failed order validations did not persist orphan orders
            orders_resp = await client.get("/orders/", headers=headers)
            assert orders_resp.status_code == 200
            assert orders_resp.json() == []

            # Cancel non-existent order
            resp = await client.post("/orders/9999/cancel", headers=headers)
            assert resp.status_code == 404
            assert resp.json()["detail"] == "Order not found"
            assert emitted == []

            # Duplicate product name
            resp = await client.post(
                "/inventory/",
                json={"name": "Coffee 1", "price": 3.5, "stock": 10},
                headers=headers,
            )
            assert resp.status_code == 400
            assert resp.json()["detail"] == "Product name already exists"
            assert emitted == []

            # Update non-existent product
            resp = await client.put(
                "/inventory/9999",
                json={"name": "Ghost", "price": 1.0, "stock": 1},
                headers=headers,
            )
            assert resp.status_code == 404
            assert resp.json()["detail"] == "Product not found"
            assert emitted == []

            # Delete non-existent product
            resp = await client.delete("/inventory/9999", headers=headers)
            assert resp.status_code == 404
            assert resp.json()["detail"] == "Product not found"
            assert emitted == []

            # Create valid order referencing product 1, then verify product 1 cannot be deleted
            order_resp = await client.post(
                "/orders/",
                json={"status": "pending", "items": [{"product_id": 1, "quantity": 4}]},
                headers=headers,
            )
            assert order_resp.status_code == 200
            order_id = order_resp.json()["id"]
            emitted.clear()

            del_in_use = await client.delete("/inventory/1", headers=headers)
            assert del_in_use.status_code == 400
            assert (
                del_in_use.json()["detail"]
                == "Cannot delete a product used in existing orders"
            )
            assert emitted == []

            # Cancel once -> emits stock_update & order_cancelled; cancel again -> idempotent, 0 events
            cancel_1 = await client.post(f"/orders/{order_id}/cancel", headers=headers)
            assert cancel_1.status_code == 200
            assert cancel_1.json()["items"][0]["product"]["stock"] == 100
            assert emitted == [
                ("stock_update", None),
                ("order_cancelled", {"order_id": order_id}),
            ]

            emitted.clear()
            cancel_2 = await client.post(f"/orders/{order_id}/cancel", headers=headers)
            assert cancel_2.status_code == 200
            assert cancel_2.json()["status"] == "cancelled"
            assert cancel_2.json()["items"][0]["product"]["stock"] == 100
            assert emitted == []

            assert test_engine.pool.checkedout() == 0

    _run_async(_run())


def test_sync_routes_and_auth_continue_working_unchanged(pooled_db):
    """Verify existing synchronous def routes work seamlessly with detached auth User."""
    test_engine, _ = pooled_db
    manager_headers = _auth_headers("manager")
    staff_headers = _auth_headers("staff")

    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            # Auth /me and invalid token
            me_resp = await client.get("/auth/me", headers=manager_headers)
            assert me_resp.status_code == 200
            assert me_resp.json()["username"] == "manager"
            assert me_resp.json()["is_manager"] is True

            bad_resp = await client.get(
                "/auth/me", headers={"Authorization": "Bearer invalid.token.value"}
            )
            assert bad_resp.status_code == 401

            # Dashboard & reports sync routes
            dash_resp = await client.get("/dashboard/summary", headers=manager_headers)
            assert dash_resp.status_code == 200
            assert "totalSales" in dash_resp.json()

            rep_resp = await client.get("/reports/daily", headers=manager_headers)
            assert rep_resp.status_code == 200
            assert rep_resp.json() == []

            # Users sync routes (manager vs staff permissions)
            forbidden = await client.get("/users/", headers=staff_headers)
            assert forbidden.status_code == 403

            create_u = await client.post(
                "/users/",
                json={"username": "barista2", "password": "secret", "is_manager": False},
                headers=manager_headers,
            )
            assert create_u.status_code == 200
            new_uid = create_u.json()["id"]

            list_u = await client.get("/users/", headers=manager_headers)
            assert list_u.status_code == 200
            assert any(u["id"] == new_uid for u in list_u.json())

            del_u = await client.delete(f"/users/{new_uid}", headers=manager_headers)
            assert del_u.status_code == 200

            assert test_engine.pool.checkedout() == 0

    _run_async(_run())
