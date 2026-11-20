import os
from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass

DATABASE_URL: str = os.getenv("DATABASE_URL") or "sqlite:///./dev.db"
INSTANCE_SOCKET: str | None = os.getenv("INSTANCE_UNIX_SOCKET")

if INSTANCE_SOCKET and DATABASE_URL.startswith(("postgresql", "postgres")):
    DATABASE_URL = DATABASE_URL.replace("localhost", f"/cloudsql/{INSTANCE_SOCKET}")

connect_args: dict[str, Any] = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
elif DATABASE_URL.startswith(("postgresql", "postgres")):
    connect_args = {"sslmode": "disable"}

# Create the SQLAlchemy engine
engine = create_engine(DATABASE_URL, connect_args=connect_args)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# Base class for models
class Base(DeclarativeBase):
    pass


# Dependency to provide a DB session to FastAPI routes
def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope(request: Request | None = None) -> Generator[Session, None, None]:
    """Open a short-lived DB session on the current worker thread.

    Uses `SessionLocal()` in normal execution while honoring FastAPI
    `app.dependency_overrides[get_db]` when tests override `get_db`.
    """
    override: Callable[[], Any] | None = None
    if request is not None:
        app_obj = request.scope.get("app")
        if app_obj is not None:
            overrides: dict[Any, Callable[[], Any]] = getattr(
                app_obj, "dependency_overrides", {}
            )
            override = overrides.get(get_db)

    if override is not None:
        resolved = override()
        if isinstance(resolved, Iterator):
            db_gen: Session = next(resolved)
            try:
                yield db_gen
            except Exception:
                db_gen.rollback()
                raise
            finally:
                try:
                    next(resolved)
                except StopIteration:
                    pass
        else:
            db_direct: Session = resolved
            try:
                yield db_direct
            except Exception:
                db_direct.rollback()
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
