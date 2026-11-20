import os
import subprocess
import sys
import time
import warnings
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateTable

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("JWT_SECRET", "super-secret-test-key-for-utc-tests")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from app import auth, models  # noqa: E402
from app.database import Base  # noqa: E402


def test_token_issuance_and_model_creation_under_deprecation_error():
    """Run token issuance and model creation under -W error::DeprecationWarning."""
    script = """
import os
import sys
import warnings
from datetime import datetime, timedelta, timezone
from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

os.environ["JWT_SECRET"] = "strict-deprecation-check-secret-key"
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import models
from app.database import Base

with warnings.catch_warnings():
    warnings.filterwarnings(
        "ignore", category=DeprecationWarning, module=r"passlib\\..*"
    )
    warnings.filterwarnings(
        "ignore", category=DeprecationWarning, module=r"app\\.schemas"
    )
    from app import auth

# Active -W error::DeprecationWarning applies to all runtime calls below
token_default = auth.create_access_token({"sub": "manager"})
token_custom = auth.create_access_token(
    {"sub": "staff"}, expires_delta=timedelta(minutes=15)
)

decoded_default = jwt.decode(
    token_default, auth.get_jwt_secret(), algorithms=[auth.ALGORITHM]
)
decoded_custom = jwt.decode(
    token_custom, auth.get_jwt_secret(), algorithms=[auth.ALGORITHM]
)
assert decoded_default["sub"] == "manager"
assert decoded_custom["sub"] == "staff"

engine = create_engine("sqlite:///:memory:")
Base.metadata.create_all(bind=engine)
Session = sessionmaker(bind=engine)
db = Session()
try:
    user = models.User(username="barista", hashed_password="h", is_manager=False)
    db.add(user)
    db.flush()

    order = models.Order(user_id=user.id, status="pending")
    report = models.SalesReport(report_type="daily", total_sales=125.50)
    db.add_all([order, report])
    db.commit()
    db.refresh(order)
    db.refresh(report)

    assert order.created_at.tzinfo == timezone.utc
    assert report.created_at.tzinfo == timezone.utc
finally:
    db.close()
    engine.dispose()
"""
    result = subprocess.run(
        [sys.executable, "-W", "error::DeprecationWarning", "-c", script],
        cwd=str(BACKEND_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"Subprocess failed with code {result.returncode}:\n"
        f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    )


def test_jwt_access_token_epoch_conversion_without_offset_drift():
    """Verify JWT serializers convert UTC timestamps into standard Unix epochs."""
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        before_epoch = int(time.time())
        token = auth.create_access_token({"sub": "manager"})
        after_epoch = int(time.time())

        payload = jwt.decode(
            token,
            auth.get_jwt_secret(),
            algorithms=[auth.ALGORITHM],
        )

    expected_min = before_epoch + auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    expected_max = after_epoch + auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    assert expected_min <= payload["exp"] <= expected_max

    custom_delta = timedelta(minutes=5, seconds=30)
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        before_custom = int(time.time())
        custom_token = auth.create_access_token(
            {"sub": "staff"},
            expires_delta=custom_delta,
        )
        after_custom = int(time.time())
        custom_payload = jwt.decode(
            custom_token,
            auth.get_jwt_secret(),
            algorithms=[auth.ALGORITHM],
        )

    assert (
        before_custom + int(custom_delta.total_seconds())
        <= custom_payload["exp"]
        <= after_custom + int(custom_delta.total_seconds())
    )


def test_order_and_sales_report_persist_timezone_aware_utc_accurately():
    """Ensure SQLAlchemy defaults and UTC timestamps round-trip without drift."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = Session()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            before_utc = datetime.now(UTC)
            order = models.Order(user_id=None, status="pending")
            report = models.SalesReport(report_type="weekly", total_sales=540.25)
            db.add_all([order, report])
            db.flush()
            after_utc = datetime.now(UTC)

            assert order.created_at.tzinfo == UTC
            assert report.created_at.tzinfo == UTC
            assert before_utc <= order.created_at <= after_utc
            assert before_utc <= report.created_at <= after_utc

            flushed_order_ts = order.created_at
            flushed_report_ts = report.created_at

            # Explicit non-UTC offset timestamp must normalize to UTC on persistence
            pst_tz = timezone(timedelta(hours=-8))
            explicit_pst = datetime(2026, 11, 20, 9, 15, 30, 123456, tzinfo=pst_tz)
            offset_order = models.Order(
                user_id=None,
                status="completed",
                created_at=explicit_pst,
            )
            db.add(offset_order)
            db.commit()

            order_id = order.id
            report_id = report.id
            offset_order_id = offset_order.id

        db.expire_all()
        reloaded_order = db.query(models.Order).filter_by(id=order_id).one()
        reloaded_report = db.query(models.SalesReport).filter_by(id=report_id).one()
        reloaded_offset_order = (
            db.query(models.Order).filter_by(id=offset_order_id).one()
        )

        assert reloaded_order.created_at.tzinfo == UTC
        assert reloaded_report.created_at.tzinfo == UTC
        assert reloaded_order.created_at == flushed_order_ts
        assert reloaded_report.created_at == flushed_report_ts

        expected_utc = datetime(2026, 11, 20, 17, 15, 30, 123456, tzinfo=UTC)
        assert reloaded_offset_order.created_at.tzinfo == UTC
        assert reloaded_offset_order.created_at == expected_utc
    finally:
        db.close()
        engine.dispose()


def test_database_schema_column_types_remain_unchanged():
    """Ensure SQL column DDL types remain DATETIME / TIMESTAMP WITHOUT TIME ZONE."""
    orders_table = Base.metadata.tables["orders"]
    reports_table = Base.metadata.tables["sales_reports"]
    pg_orders_ddl = str(CreateTable(orders_table).compile(dialect=postgresql.dialect()))
    pg_reports_ddl = str(
        CreateTable(reports_table).compile(dialect=postgresql.dialect())
    )
    sq_orders_ddl = str(CreateTable(orders_table).compile(dialect=sqlite.dialect()))
    sq_reports_ddl = str(CreateTable(reports_table).compile(dialect=sqlite.dialect()))

    assert "created_at TIMESTAMP WITHOUT TIME ZONE" in pg_orders_ddl
    assert "created_at TIMESTAMP WITHOUT TIME ZONE" in pg_reports_ddl
    assert "created_at DATETIME" in sq_orders_ddl
    assert "created_at DATETIME" in sq_reports_ddl
