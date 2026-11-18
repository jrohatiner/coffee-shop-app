import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Ensure `app` package is importable whether pytest is run from repo root or backend/
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_BOOTSTRAP_DB_FD, _BOOTSTRAP_DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_BOOTSTRAP_DB_FD)
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_BOOTSTRAP_DB_PATH}")

from app import auth, models  # noqa: E402
from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402

_TEST_PASSWORD_HASH = auth.get_password_hash("testpass123")


@pytest.fixture(scope="session", autouse=True)
def cleanup_bootstrap_db():
    yield
    if os.path.exists(_BOOTSTRAP_DB_PATH):
        os.remove(_BOOTSTRAP_DB_PATH)


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

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_db, None)


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
