import importlib.util
import re
import warnings
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import TypeAdapter
from pydantic.warnings import PydanticDeprecatedSince20

from app import auth, models, schemas
from app.routers.orders import _serialize_order

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
SCHEMAS_PATH = BACKEND_DIR / "app" / "schemas.py"
INVENTORY_ROUTER_PATH = BACKEND_DIR / "app" / "routers" / "inventory.py"
ORDERS_ROUTER_PATH = BACKEND_DIR / "app" / "routers" / "orders.py"
BOOTSTRAP_SCRIPT_PATH = REPO_ROOT / "bootstrap_coffee_shop.sh"


def _filter_pydantic_legacy_warnings(recorded):
    return [
        w
        for w in recorded
        if issubclass(w.category, PydanticDeprecatedSince20)
        or isinstance(w.message, PydanticDeprecatedSince20)
        or "orm_mode" in str(w.message)
    ]


def test_schemas_import_and_config_emit_zero_deprecation_or_orm_mode_warnings():
    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("always")
        spec = importlib.util.spec_from_file_location(
            "_isolated_app_schemas_v2", SCHEMAS_PATH
        )
        assert spec is not None and spec.loader is not None
        isolated_schemas = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(isolated_schemas)

    assert _filter_pydantic_legacy_warnings(recorded) == []

    response_model_names = (
        "UserOut",
        "ProductOut",
        "OrderItemOut",
        "OrderSummaryOut",
        "OrderOut",
        "SalesReportOut",
    )
    for model_name in response_model_names:
        for mod in (schemas, isolated_schemas):
            cls = getattr(mod, model_name)
            assert cls.model_config.get("from_attributes") is True, (
                f"{model_name} must enable from_attributes=True"
            )
            assert "Config" not in cls.__dict__, (
                f"{model_name} must not define legacy class Config"
            )


def test_bootstrap_script_schema_template_uses_pydantic_v2_without_warnings():
    if not BOOTSTRAP_SCRIPT_PATH.exists():
        pytest.skip("Bootstrap script absent in standalone container context")
    script_text = BOOTSTRAP_SCRIPT_PATH.read_text(encoding="utf-8")
    match = re.search(
        r"cat > backend/app/schemas\.py << 'EOF'\n(.*?)\nEOF",
        script_text,
        flags=re.DOTALL,
    )
    assert match is not None, (
        "Could not locate backend/app/schemas.py template in bootstrap_coffee_shop.sh"
    )
    template_source = match.group(1)
    assert "orm_mode" not in template_source
    assert "class Config" not in template_source

    namespace: dict[str, Any] = {}
    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("always")
        exec(compile(template_source, "bootstrap_schemas.py", "exec"), namespace)

    assert _filter_pydantic_legacy_warnings(recorded) == []

    for model_name in (
        "UserOut",
        "ProductOut",
        "OrderItemOut",
        "OrderOut",
        "SalesReportOut",
    ):
        cls = namespace[model_name]
        assert cls.model_config.get("from_attributes") is True
        assert "Config" not in cls.__dict__


def test_routers_do_not_retain_legacy_v1_calls_or_shims():
    inventory_src = INVENTORY_ROUTER_PATH.read_text(encoding="utf-8")
    orders_src = ORDERS_ROUTER_PATH.read_text(encoding="utf-8")

    assert ".dict(" not in inventory_src
    assert "from_orm" not in inventory_src
    assert "product_in.model_dump()" in inventory_src

    assert "from_orm" not in orders_src
    assert ".construct" not in orders_src
    assert "OrderOut.model_validate" in orders_src
    assert "OrderItemOut.model_validate" in orders_src
    assert "OrderOut.model_construct" in orders_src
    assert "OrderItemOut.model_construct" in orders_src


def test_orm_validation_parity_and_projected_row_summaries(db_session):
    ts = datetime(2026, 11, 18, 12, 0, 0, 123456, tzinfo=UTC)
    user = db_session.query(models.User).filter_by(username="manager").first()
    assert user is not None

    espresso = models.Product(name="V2 Espresso", price=3.25, stock=50)
    latte = models.Product(name="V2 Latte", price=4.75, stock=40)
    report = models.SalesReport(report_type="daily", total_sales=128.5, created_at=ts)
    db_session.add_all([espresso, latte, report])
    db_session.flush()

    order = models.Order(user_id=user.id, status="pending", created_at=ts)
    order.items = [
        models.OrderItem(product_id=espresso.id, quantity=2, product=espresso),
        models.OrderItem(product_id=latte.id, quantity=1, product=latte),
    ]
    db_session.add(order)
    db_session.commit()
    db_session.refresh(order)

    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("always")

        user_out = schemas.UserOut.model_validate(user)
        assert user_out.model_dump() == {
            "id": user.id,
            "username": "manager",
            "is_manager": True,
        }

        product_out = schemas.ProductOut.model_validate(espresso)
        assert product_out.model_dump() == {
            "id": espresso.id,
            "name": "V2 Espresso",
            "price": 3.25,
            "stock": 50,
        }

        item_out = schemas.OrderItemOut.model_validate(order.items[0])
        assert item_out.model_dump() == {
            "id": order.items[0].id,
            "product_id": espresso.id,
            "quantity": 2,
            "product": {
                "id": espresso.id,
                "name": "V2 Espresso",
                "price": 3.25,
                "stock": 50,
            },
        }

        order_out = schemas.OrderOut.model_validate(order)
        assert order_out.id == order.id
        assert order_out.user_id == user.id
        assert order_out.status == "pending"
        assert order_out.created_at == ts
        assert len(order_out.items) == 2

        report_out = schemas.SalesReportOut.model_validate(report)
        assert report_out.model_dump() == {
            "id": report.id,
            "report_type": "daily",
            "total_sales": 128.5,
            "created_at": ts,
        }

        # Parity with test_orders.py projected SQLAlchemy Row tuple serialization
        rows = (
            db_session.query(
                models.Order.id, models.Order.status, models.Order.created_at
            )
            .filter(models.Order.id == order.id)
            .all()
        )
        assert len(rows) == 1

        summary_single = schemas.OrderSummaryOut.model_validate(rows[0])
        assert summary_single.model_dump() == {
            "id": order.id,
            "status": "pending",
            "created_at": ts,
        }

        adapter = TypeAdapter(list[schemas.OrderSummaryOut])
        validated_default = adapter.validate_python(rows)
        validated_from_attrs = adapter.validate_python(rows, from_attributes=True)
        assert validated_default == validated_from_attrs
        assert adapter.dump_python(validated_default) == [
            {"id": order.id, "status": "pending", "created_at": ts}
        ]

    assert _filter_pydantic_legacy_warnings(recorded) == []
    db_session.query(models.SalesReport).delete()
    db_session.commit()


def test_inventory_and_order_null_product_fallback_emit_zero_warnings(
    client, db_session
):
    token = auth.create_access_token({"sub": "manager"})
    headers = {"Authorization": f"Bearer {token}"}

    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("always")
        with patch("app.websockets.sio.emit", new_callable=AsyncMock) as sio_emit:
            p1_resp = client.post(
                "/inventory/",
                json={"name": "Cortado V2", "price": 4.0, "stock": 20},
                headers=headers,
            )
            assert p1_resp.status_code == 201
            p1 = p1_resp.json()
            assert set(p1.keys()) == {"id", "name", "price", "stock"}

            p2_resp = client.post(
                "/inventory/",
                json={"name": "Seasonal Pour Over V2", "price": 5.5, "stock": 15},
                headers=headers,
            )
            assert p2_resp.status_code == 201
            p2 = p2_resp.json()
            assert sio_emit.await_count == 2

            order_resp = client.post(
                "/orders/",
                json={
                    "items": [
                        {"product_id": p1["id"], "quantity": 3},
                        {"product_id": p2["id"], "quantity": 2},
                    ]
                },
                headers=headers,
            )
            assert order_resp.status_code == 200
            created_order = order_resp.json()
            order_id = created_order["id"]
            assert set(created_order.keys()) == {
                "id",
                "user_id",
                "status",
                "created_at",
                "items",
            }

            list_resp = client.get("/orders/", headers=headers)
            assert list_resp.status_code == 200
            summaries = list_resp.json()
            assert any(
                s["id"] == order_id and set(s.keys()) == {"id", "status", "created_at"}
                for s in summaries
            )

            # Delete one Product row directly so OrderItem.product resolves to None
            # (parity with test_order_mutations.py lines 439-468)
            db_session.query(models.Product).filter(
                models.Product.id == p2["id"]
            ).delete()
            db_session.commit()
            db_session.expire_all()

            orm_order = (
                db_session.query(models.Order)
                .filter(models.Order.id == order_id)
                .first()
            )
            assert orm_order is not None
            serialized_fallback = _serialize_order(orm_order)
            by_product_id = {it.product_id: it for it in serialized_fallback.items}
            assert by_product_id[p1["id"]].product is not None
            assert by_product_id[p1["id"]].product.name == "Cortado V2"
            assert by_product_id[p2["id"]].product is None

            sio_emit.reset_mock()
            cancel_resp = client.post(
                f"/orders/{order_id}/cancel",
                headers=headers,
            )
            assert cancel_resp.status_code == 200
            cancelled = cancel_resp.json()
            assert cancelled["status"] == "cancelled"
            cancelled_items = {it["product_id"]: it for it in cancelled["items"]}
            assert cancelled_items[p1["id"]]["product"] == {
                "id": p1["id"],
                "name": "Cortado V2",
                "price": 4.0,
                "stock": 20,
            }
            assert cancelled_items[p2["id"]]["product"] is None
            assert sio_emit.await_count == 2

    assert _filter_pydantic_legacy_warnings(recorded) == []
