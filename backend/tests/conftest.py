import os
from pathlib import Path
import sys
import tempfile

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_CONFTEST_DB_FD, _CONFTEST_DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_CONFTEST_DB_FD)

# Ensure a secure JWT secret and test SQLite database are set for test session
os.environ["JWT_SECRET"] = "super-secret-test-key-for-auth-tests"
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_CONFTEST_DB_PATH}")

import pytest
from fastapi.testclient import TestClient
from passlib.context import CryptContext
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import database as database_module, models
from app.database import Base, get_db
from app.main import app

TEST_DATABASE_URL = f"sqlite:///{_CONFTEST_DB_PATH}"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated=["auto"])


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    db = TestingSessionLocal()
    try:
        # Seed manager and staff users
        if not db.query(models.User).filter_by(username="manager").first():
            db.add(
                models.User(
                    username="manager",
                    hashed_password=pwd_context.hash("manager123"),
                    is_manager=True,
                )
            )
        if not db.query(models.User).filter_by(username="staff").first():
            db.add(
                models.User(
                    username="staff",
                    hashed_password=pwd_context.hash("staff123"),
                    is_manager=False,
                )
            )
        db.commit()
    finally:
        db.close()
    yield
    Base.metadata.drop_all(bind=test_engine)
    test_engine.dispose()
    if os.path.exists(_CONFTEST_DB_PATH):
        try:
            os.remove(_CONFTEST_DB_PATH)
        except OSError:
            pass


@pytest.fixture(autouse=True)
def _preserve_database_bindings():
    prev_engine = database_module.engine
    prev_session_local = database_module.SessionLocal
    prev_bind = (
        prev_session_local.kw.get("bind")
        if hasattr(prev_session_local, "kw")
        else None
    )
    try:
        yield
    finally:
        database_module.engine = prev_engine
        if database_module.SessionLocal is prev_session_local and prev_bind is not None:
            database_module.SessionLocal.configure(bind=prev_bind)


@pytest.fixture
def client():
    previous_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as c:
            yield c
    finally:
        if previous_override is not None:
            app.dependency_overrides[get_db] = previous_override
        else:
            app.dependency_overrides.pop(get_db, None)
