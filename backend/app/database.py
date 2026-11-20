from contextlib import contextmanager
import importlib.util
import os
from typing import Optional, Tuple
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base


class DatabaseConfigurationError(RuntimeError, ValueError):
    """Raised when database or runtime configuration is missing or insecure."""
    pass


PRODUCTION_PLACEHOLDER_MARKERS = (
    "replace-me",
    "replace_me",
    "replace-with",
    "dev_secret_key",
    "your_project_id",
    "your_db_password",
    "your-project-id",
    "your-db-password",
    "changeme",
    "local-dev-secret-not-for-production",
)
PRODUCTION_MIN_SECRET_LENGTH = 32


def is_production_env() -> bool:
    return (
        os.getenv("APP_ENV", "").strip().lower() == "production"
        or bool(os.getenv("K_SERVICE", "").strip())
    )


if not is_production_env():
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except Exception:
        pass


def validate_database_config() -> Tuple[str, Optional[str]]:
    raw_db_url = os.getenv("DATABASE_URL")
    instance_socket = os.getenv("INSTANCE_UNIX_SOCKET")

    if is_production_env():
        jwt_secret = os.getenv("JWT_SECRET")
        if jwt_secret is not None:
            stripped_jwt = jwt_secret.strip()
            lower_jwt = stripped_jwt.lower()
            if (
                not stripped_jwt
                or len(stripped_jwt) < PRODUCTION_MIN_SECRET_LENGTH
                or any(marker in lower_jwt for marker in PRODUCTION_PLACEHOLDER_MARKERS)
            ):
                raise DatabaseConfigurationError(
                    "JWT_SECRET environment variable is missing, weak, or uses a placeholder value in production."
                )

        if raw_db_url is None or not raw_db_url.strip():
            raise DatabaseConfigurationError(
                "DATABASE_URL environment variable is required in production."
            )
        db_url = raw_db_url.strip()
        lower_db_url = db_url.lower()
        if db_url == "sqlite:///./dev.db" or any(
            marker in lower_db_url for marker in PRODUCTION_PLACEHOLDER_MARKERS
        ):
            raise DatabaseConfigurationError(
                "DATABASE_URL environment variable uses an unconfigured placeholder or local dev database in production."
            )

        if instance_socket is not None:
            stripped_socket = instance_socket.strip()
            lower_socket = stripped_socket.lower()
            if (
                not stripped_socket
                or "your_" in lower_socket
                or "your-" in lower_socket
                or any(marker in lower_socket for marker in PRODUCTION_PLACEHOLDER_MARKERS)
            ):
                raise DatabaseConfigurationError(
                    "INSTANCE_UNIX_SOCKET environment variable is blank or uses an unconfigured placeholder value in production."
                )
            instance_socket = stripped_socket
        return db_url, instance_socket

    # Fallback to SQLite for quick local runs if DATABASE_URL is not provided
    db_url = (raw_db_url or "").strip() or "sqlite:///./dev.db"
    return db_url, instance_socket


DATABASE_URL, INSTANCE_SOCKET = validate_database_config()

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    if importlib.util.find_spec("psycopg") is None:
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
