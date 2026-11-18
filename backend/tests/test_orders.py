import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

TEST_ENGINE = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=TEST_ENGINE)

with patch("sqlalchemy.create_engine", return_value=TEST_ENGINE):
    from app import auth, models
    from app.database import Base, get_db
    from app.main import app


@pytest.fixture()
def db_session():
    Base.metadata.create_all(bind=TEST_ENGINE)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=TEST_ENGINE)


@pytest.fixture()
def client(db_session):
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with patch("app.routers.orders.sio.emit", new_callable=AsyncMock):
        with TestClient(app) as test_client:
            yield test_client
    app.dependency_overrides.pop(get_db, None)


def _create_user(db_session, username: str, is_manager: bool = False) -> models.User:
    user = models.User(
        username=username,
        hashed_password="hashed_test_password",
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
