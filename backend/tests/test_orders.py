import os
import sys
import tempfile
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
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, event  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

test_engine = create_engine(
    f"sqlite:///{_TEST_DB_PATH}",
    connect_args={"check_same_thread": False},
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

from app import auth, models  # noqa: E402
from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.routers.orders import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE  # noqa: E402

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
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth_headers(setup_db):
    db = TestingSessionLocal()
    try:
        with patch("app.routers.orders.sio.emit", new_callable=AsyncMock):
            with TestClient(app) as test_client:
                yield test_client
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
