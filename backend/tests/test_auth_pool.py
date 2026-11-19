import asyncio
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.pool import QueuePool

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Ensure app.database can initialize lazily without an external Postgres instance
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://postgres:postgres@localhost:5432/coffee_test",
)

import app.database as database_module  # noqa: E402

_bootstrap_db_fd, _bootstrap_db_path = tempfile.mkstemp(suffix=".db")
os.close(_bootstrap_db_fd)
_bootstrap_engine = create_engine(
    f"sqlite:///{_bootstrap_db_path}",
    connect_args={"check_same_thread": False},
)
database_module.engine = _bootstrap_engine
database_module.SessionLocal.configure(bind=_bootstrap_engine)

from app import auth, models  # noqa: E402
from app.database import get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import users as users_router  # noqa: E402

_bootstrap_engine.dispose()
if os.path.exists(_bootstrap_db_path):
    os.remove(_bootstrap_db_path)

# Precompute 12-round bcrypt hashes once for fast per-test fixture seeding
MANAGER_HASH = auth.get_password_hash("manager123")
STAFF_HASH = auth.get_password_hash("staff123")


@pytest.fixture()
def pool_env(tmp_path):
    db_file = tmp_path / "coffee_pool_test.db"
    test_engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False, "timeout": 30},
        poolclass=QueuePool,
        pool_size=5,
        max_overflow=10,
        pool_timeout=30,
    )

    @event.listens_for(test_engine, "connect")
    def _configure_sqlite(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    database_module.engine = test_engine
    database_module.SessionLocal.configure(bind=test_engine)
    models.Base.metadata.create_all(bind=test_engine)

    seed_db = database_module.SessionLocal()
    try:
        seed_db.add(
            models.User(
                username="manager",
                hashed_password=MANAGER_HASH,
                is_manager=True,
            )
        )
        seed_db.add(
            models.User(
                username="staff",
                hashed_password=STAFF_HASH,
                is_manager=False,
            )
        )
        seed_db.add(models.Product(name="Espresso", price=3.0, stock=100))
        seed_db.commit()
    finally:
        seed_db.close()

    assert test_engine.pool.checkedout() == 0
    try:
        yield test_engine
    finally:
        test_engine.dispose()


def test_login_holds_zero_connections_during_verify_password(pool_env, monkeypatch):
    checkedout_during_verify = []
    original_verify = auth.verify_password

    def spy_verify_password(plain_password: str, hashed_password: str) -> bool:
        checkedout_during_verify.append(pool_env.pool.checkedout())
        return original_verify(plain_password, hashed_password)

    monkeypatch.setattr(auth, "verify_password", spy_verify_password)

    with TestClient(app) as client:
        resp = client.post(
            "/auth/token",
            data={"username": "manager", "password": "manager123"},
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["token_type"] == "bearer"
        assert payload["access_token"]

        me_resp = client.get(
            "/auth/me",
            headers={"Authorization": f"Bearer {payload['access_token']}"},
        )
        assert me_resp.status_code == 200
        assert me_resp.json()["username"] == "manager"

    assert checkedout_during_verify == [0]
    assert pool_env.pool.checkedout() == 0


def test_create_user_holds_zero_connections_during_get_password_hash(
    pool_env, monkeypatch
):
    checkedout_during_hash = []
    original_hash = auth.get_password_hash

    def spy_get_password_hash(password: str) -> str:
        checkedout_during_hash.append(pool_env.pool.checkedout())
        return original_hash(password)

    monkeypatch.setattr(auth, "get_password_hash", spy_get_password_hash)
    monkeypatch.setattr(users_router, "get_password_hash", spy_get_password_hash)

    manager_token = auth.create_access_token({"sub": "manager"})

    with TestClient(app) as client:
        resp = client.post(
            "/users/",
            json={
                "username": "barista_one",
                "password": "barista_pass",
                "is_manager": False,
            },
            headers={"Authorization": f"Bearer {manager_token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["username"] == "barista_one"
        assert body["is_manager"] is False
        assert isinstance(body["id"], int)

        login_resp = client.post(
            "/auth/token",
            data={"username": "barista_one", "password": "barista_pass"},
        )
        assert login_resp.status_code == 200

    assert checkedout_during_hash == [0]
    assert pool_env.pool.checkedout() == 0


def test_login_returns_401_for_invalid_credentials(pool_env, monkeypatch):
    checkedout_during_verify = []
    original_verify = auth.verify_password

    def spy_verify_password(plain_password: str, hashed_password: str) -> bool:
        checkedout_during_verify.append(pool_env.pool.checkedout())
        return original_verify(plain_password, hashed_password)

    monkeypatch.setattr(auth, "verify_password", spy_verify_password)

    with TestClient(app) as client:
        bad_pw = client.post(
            "/auth/token",
            data={"username": "manager", "password": "wrong_password"},
        )
        assert bad_pw.status_code == 401
        assert bad_pw.json()["detail"] == "Incorrect username or password"

        missing_user = client.post(
            "/auth/token",
            data={"username": "nonexistent", "password": "wrong_password"},
        )
        assert missing_user.status_code == 401
        assert missing_user.json()["detail"] == "Incorrect username or password"

    assert checkedout_during_verify == [0]
    assert pool_env.pool.checkedout() == 0


def test_create_user_enforces_403_and_precheck_400(pool_env, monkeypatch):
    hash_calls = []
    original_hash = auth.get_password_hash

    def spy_get_password_hash(password: str) -> str:
        hash_calls.append(password)
        return original_hash(password)

    monkeypatch.setattr(auth, "get_password_hash", spy_get_password_hash)
    monkeypatch.setattr(users_router, "get_password_hash", spy_get_password_hash)

    staff_token = auth.create_access_token({"sub": "staff"})
    manager_token = auth.create_access_token({"sub": "manager"})

    with TestClient(app) as client:
        forbidden = client.post(
            "/users/",
            json={"username": "unauth_user", "password": "pw", "is_manager": False},
            headers={"Authorization": f"Bearer {staff_token}"},
        )
        assert forbidden.status_code == 403
        assert forbidden.json()["detail"] == "Only managers can create users"

        duplicate = client.post(
            "/users/",
            json={"username": "staff", "password": "pw", "is_manager": False},
            headers={"Authorization": f"Bearer {manager_token}"},
        )
        assert duplicate.status_code == 400
        assert duplicate.json()["detail"] == "Username already exists"

    assert hash_calls == []
    assert pool_env.pool.checkedout() == 0


def test_create_user_concurrent_duplicate_returns_400(pool_env, monkeypatch):
    barrier = threading.Barrier(2)
    checkedout_at_barrier = []
    lock = threading.Lock()
    original_hash = auth.get_password_hash

    def synced_get_password_hash(password: str) -> str:
        barrier.wait(timeout=5.0)
        with lock:
            checkedout_at_barrier.append(pool_env.pool.checkedout())
        return original_hash(password)

    monkeypatch.setattr(auth, "get_password_hash", synced_get_password_hash)
    monkeypatch.setattr(users_router, "get_password_hash", synced_get_password_hash)

    manager_token = auth.create_access_token({"sub": "manager"})

    async def run_concurrent_creates():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            payload = {
                "username": "concurrent_barista",
                "password": "secret_password",
                "is_manager": False,
            }
            headers = {"Authorization": f"Bearer {manager_token}"}
            return await asyncio.gather(
                client.post("/users/", json=payload, headers=headers),
                client.post("/users/", json=payload, headers=headers),
            )

    responses = asyncio.run(run_concurrent_creates())
    statuses = sorted(r.status_code for r in responses)
    assert statuses == [200, 400]

    error_resp = next(r for r in responses if r.status_code == 400)
    assert error_resp.json()["detail"] == "Username already exists"
    assert checkedout_at_barrier == [0, 0]
    assert pool_env.pool.checkedout() == 0

    check_db = database_module.SessionLocal()
    try:
        count = (
            check_db.query(models.User)
            .filter(models.User.username == "concurrent_barista")
            .count()
        )
        assert count == 1
    finally:
        check_db.close()


def test_inventory_latency_under_16_concurrent_logins(pool_env, monkeypatch):
    entered_verify = 0
    active_verify = 0
    lock = threading.Lock()
    all_logins_hashing = threading.Event()
    checkedout_when_all_hashing = []
    original_verify = auth.verify_password

    def tracked_verify_password(plain_password: str, hashed_password: str) -> bool:
        nonlocal entered_verify, active_verify
        with lock:
            entered_verify += 1
            active_verify += 1
            if entered_verify == 16:
                checkedout_when_all_hashing.append(pool_env.pool.checkedout())
                all_logins_hashing.set()
        try:
            return original_verify(plain_password, hashed_password)
        finally:
            with lock:
                active_verify -= 1

    monkeypatch.setattr(auth, "verify_password", tracked_verify_password)
    manager_token = auth.create_access_token({"sub": "manager"})

    async def run_burst():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            # Warm route / connection pool once before timing burst latency
            warm = await client.get(
                "/inventory/",
                headers={"Authorization": f"Bearer {manager_token}"},
            )
            assert warm.status_code == 200

            login_tasks = [
                asyncio.create_task(
                    client.post(
                        "/auth/token",
                        data={"username": "manager", "password": "manager123"},
                    )
                )
                for _ in range(16)
            ]

            reached = await asyncio.to_thread(all_logins_hashing.wait, 5.0)
            assert reached, "Expected all 16 logins to enter verify_password concurrently"

            t0 = time.perf_counter()
            inv_resp = await client.get(
                "/inventory/",
                headers={"Authorization": f"Bearer {manager_token}"},
            )
            inventory_ms = (time.perf_counter() - t0) * 1000.0

            login_responses = await asyncio.gather(*login_tasks)
            return inv_resp, inventory_ms, login_responses

    inv_resp, inventory_ms, login_responses = asyncio.run(run_burst())

    assert inv_resp.status_code == 200
    assert inv_resp.json() == [
        {"id": 1, "name": "Espresso", "price": 3.0, "stock": 100}
    ]
    assert checkedout_when_all_hashing == [0]
    assert inventory_ms < 250.0, (
        f"Expected GET /inventory/ to stay fast during 16-login burst, got {inventory_ms:.2f} ms"
    )
    assert all(r.status_code == 200 for r in login_responses)
    assert pool_env.pool.checkedout() == 0


def test_dependency_override_get_db_preserved(tmp_path, monkeypatch):
    override_file = tmp_path / "override_pool.db"
    override_engine = create_engine(
        f"sqlite:///{override_file}",
        connect_args={"check_same_thread": False, "timeout": 30},
        poolclass=QueuePool,
        pool_size=5,
        max_overflow=10,
    )
    from sqlalchemy.orm import sessionmaker

    OverrideSession = sessionmaker(
        autocommit=False, autoflush=False, bind=override_engine
    )
    models.Base.metadata.create_all(bind=override_engine)

    seed = OverrideSession()
    try:
        seed.add(
            models.User(
                username="override_mgr",
                hashed_password=MANAGER_HASH,
                is_manager=True,
            )
        )
        seed.commit()
    finally:
        seed.close()

    def override_get_db():
        db = OverrideSession()
        try:
            yield db
        finally:
            db.close()

    checkedout_samples = []
    orig_verify = auth.verify_password
    orig_hash = auth.get_password_hash

    monkeypatch.setattr(
        auth,
        "verify_password",
        lambda p, h: (
            checkedout_samples.append(("verify", override_engine.pool.checkedout()))
            or orig_verify(p, h)
        ),
    )
    monkeypatch.setattr(
        users_router,
        "get_password_hash",
        lambda p: (
            checkedout_samples.append(("hash", override_engine.pool.checkedout()))
            or orig_hash(p)
        ),
    )

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as client:
            login_res = client.post(
                "/auth/token",
                data={"username": "override_mgr", "password": "manager123"},
            )
            assert login_res.status_code == 200
            token = login_res.json()["access_token"]

            create_res = client.post(
                "/users/",
                json={
                    "username": "override_staff",
                    "password": "pw123",
                    "is_manager": False,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            assert create_res.status_code == 200
            assert create_res.json()["username"] == "override_staff"
    finally:
        app.dependency_overrides.pop(get_db, None)
        override_engine.dispose()

    assert checkedout_samples == [("verify", 0), ("hash", 0)]

