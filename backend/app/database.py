from contextlib import contextmanager
import os
from typing import Optional
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

DATABASE_URL: Optional[str] = os.getenv("DATABASE_URL")
INSTANCE_SOCKET = os.getenv("INSTANCE_UNIX_SOCKET")

# Fallback to SQLite for quick local runs if DATABASE_URL is not provided
if not DATABASE_URL or not DATABASE_URL.strip():
    DATABASE_URL = "sqlite:///./dev.db"

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    try:
        import psycopg  # noqa: F401
    except ImportError:
        DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg2://", 1)

# If using Cloud SQL unix socket on Cloud Run (Postgres), rewrite host
if INSTANCE_SOCKET and DATABASE_URL.startswith("postgresql"):
    DATABASE_URL = DATABASE_URL.replace("localhost", f"/cloudsql/{INSTANCE_SOCKET}")

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

# Create the SQLAlchemy engine
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for models
Base = declarative_base()

# Dependency to provide a DB session to FastAPI routes
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope(request=None):
    """Open a short-lived DB session on the current worker thread.

    Uses `SessionLocal()` in normal execution while honoring FastAPI
    `app.dependency_overrides[get_db]` when tests override `get_db`.
    """
    override = None
    if request is not None:
        app_obj = request.scope.get("app")
        if app_obj is not None:
            override = getattr(app_obj, "dependency_overrides", {}).get(get_db)

    if override is not None:
        resolved = override()
        if hasattr(resolved, "__next__"):
            db = next(resolved)
            try:
                yield db
            except Exception:
                db.rollback()
                raise
            finally:
                try:
                    next(resolved)
                except StopIteration:
                    pass
        else:
            db = resolved
            try:
                yield db
            except Exception:
                db.rollback()
                raise
        return

    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
