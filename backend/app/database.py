from contextlib import contextmanager
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

DATABASE_URL = os.getenv("DATABASE_URL") or "sqlite:///./dev.db"
INSTANCE_SOCKET = os.getenv("INSTANCE_UNIX_SOCKET")

if INSTANCE_SOCKET and DATABASE_URL and DATABASE_URL.startswith("postgresql"):
    DATABASE_URL = DATABASE_URL.replace("localhost", f"/cloudsql/{INSTANCE_SOCKET}")

connect_args = (
    {"check_same_thread": False}
    if DATABASE_URL and DATABASE_URL.startswith("sqlite")
    else {"sslmode": "disable"}
)

# Create the SQLAlchemy engine
engine = create_engine(DATABASE_URL, connect_args=connect_args)

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
