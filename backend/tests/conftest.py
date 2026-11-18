import os
import pytest

# Ensure a secure JWT secret and test SQLite database are set for test session
os.environ["JWT_SECRET"] = "super-secret-test-key-for-auth-tests"
os.environ["DATABASE_URL"] = "sqlite:///./test.db"

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient
from passlib.context import CryptContext

from app.database import Base, get_db
from app.main import app
from app import models

TEST_DATABASE_URL = "sqlite:///./test.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated=["auto"])

def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()

app.dependency_overrides[get_db] = override_get_db

@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    db = TestingSessionLocal()
    # Seed manager and staff users
    if not db.query(models.User).filter_by(username="manager").first():
        db.add(models.User(
            username="manager",
            hashed_password=pwd_context.hash("manager123"),
            is_manager=True
        ))
    if not db.query(models.User).filter_by(username="staff").first():
        db.add(models.User(
            username="staff",
            hashed_password=pwd_context.hash("staff123"),
            is_manager=False
        ))
    db.commit()
    db.close()
    yield
    Base.metadata.drop_all(bind=test_engine)
    if os.path.exists("./test.db"):
        try:
            os.remove("./test.db")
        except OSError:
            pass

@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
