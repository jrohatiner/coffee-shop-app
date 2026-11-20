from datetime import date, datetime, time, timedelta
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder
from sqlalchemy import false
from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy.orm.attributes import set_committed_value

from app import auth, database, models, schemas
from app.database import get_db
from app.websockets import sio

router = APIRouter()

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100
ALLOWED_ORDER_STATUSES = {s.value for s in schemas.OrderStatus}


def _serialize_order_summary(order) -> dict:
    summary = schemas.OrderSummaryOut(
        id=order.id,
        status=order.status,
        created_at=order.created_at,
    )
    return jsonable_encoder(summary)


def _orders_with_details_query(db: Session):
    return db.query(models.Order).options(
        joinedload(models.Order.items).joinedload(models.OrderItem.product)
    )


def _get_order_with_details(db: Session, order_id: int) -> Optional[models.Order]:
    return (
        _orders_with_details_query(db)
        .populate_existing()
        .filter(models.Order.id == order_id)
        .first()
    )


def _serialize_order(order: models.Order) -> schemas.OrderOut:
    if all(it.product is not None for it in order.items):
        if hasattr(schemas.OrderOut, "model_validate"):
            return schemas.OrderOut.model_validate(order, from_attributes=True)
        return schemas.OrderOut.from_orm(order)

    items_out = []
    for it in order.items:
        if it.product is not None:
            item_out = (
                schemas.OrderItemOut.model_validate(it, from_attributes=True)
                if hasattr(schemas.OrderItemOut, "model_validate")
                else schemas.OrderItemOut.from_orm(it)
            )
        else:
            item_construct = getattr(
                schemas.OrderItemOut, "model_construct", schemas.OrderItemOut.construct
            )
            item_out = item_construct(
                id=it.id,
                product_id=it.product_id,
                quantity=it.quantity,
                product=None,
            )
        items_out.append(item_out)

    order_construct = getattr(
        schemas.OrderOut, "model_construct", schemas.OrderOut.construct
    )
    return order_construct(
        id=order.id,
        user_id=order.user_id,
        status=order.status,
        created_at=order.created_at,
        items=items_out,
    )


def _create_order_sync(
    user_id: Optional[int],
    order: schemas.OrderCreate,
    request: Request,
) -> schemas.OrderOut:
    with database.session_scope(request) as db:
        product_ids = sorted({item.product_id for item in order.items})
        product_map: Dict[int, models.Product] = {}
        if product_ids:
            products = (
                db.query(models.Product)
                .filter(models.Product.id.in_(product_ids))
                .order_by(models.Product.id)
                .with_for_update()
                .all()
            )
            product_map = {prod.id: prod for prod in products}

        requested_quantities: Dict[int, int] = {}
        for item in order.items:
            prod = product_map.get(item.product_id)
            if not prod:
                raise HTTPException(400, f"Product {item.product_id} does not exist")
            if item.quantity <= 0:
                raise HTTPException(400, f"Invalid quantity for product {prod.name}")
            requested_quantities[item.product_id] = (
                requested_quantities.get(item.product_id, 0) + item.quantity
            )

        for product_id, total_quantity in requested_quantities.items():
            prod = product_map[product_id]
            if prod.stock < total_quantity:
                raise HTTPException(
                    400,
                    f"Insufficient stock for {prod.name}. Available: {prod.stock}, requested: {total_quantity}",
                )

        for product_id, total_quantity in requested_quantities.items():
            product_map[product_id].stock -= total_quantity

        db_order = models.Order(user_id=user_id, status=order.status)
        db_order.items = [
            models.OrderItem(
                product_id=item.product_id,
                quantity=item.quantity,
                product=product_map[item.product_id],
            )
            for item in order.items
        ]
        db.add(db_order)
        db.flush()

        order_out = _serialize_order(db_order)
        db.commit()
        return order_out


def _cancel_order_sync(
    order_id: int,
    current_user,
    request: Request,
) -> Tuple[schemas.OrderOut, bool]:
    with database.session_scope(request) as db:
        order = (
            db.query(models.Order)
            .options(selectinload(models.Order.items))
            .filter(models.Order.id == order_id)
            .first()
        )
        if not order:
            raise HTTPException(404, "Order not found")

        if not (order.user_id == current_user.id or current_user.is_manager):
            raise HTTPException(403, "Not authorized to cancel this order")

        if order.status in ("completed", "shipped"):
            raise HTTPException(400, "Cannot cancel order in current status")

        product_ids = sorted({it.product_id for it in order.items})
        product_map: Dict[int, models.Product] = {}
        if product_ids:
            product_query = (
                db.query(models.Product)
                .filter(models.Product.id.in_(product_ids))
                .order_by(models.Product.id)
            )
            if order.status != "cancelled":
                product_query = product_query.with_for_update()
            products = product_query.all()
            product_map = {prod.id: prod for prod in products}

        for it in order.items:
            set_committed_value(it, "product", product_map.get(it.product_id))

        if order.status == "cancelled":
            return _serialize_order(order), False

        restock_quantities: Dict[int, int] = {}
        for it in order.items:
            restock_quantities[it.product_id] = (
                restock_quantities.get(it.product_id, 0) + it.quantity
            )

        for product_id, total_quantity in restock_quantities.items():
            prod = product_map.get(product_id)
            if prod:
                prod.stock += total_quantity

        order.status = "cancelled"
        db.flush()

        order_out = _serialize_order(order)
        db.commit()
        return order_out, True


@router.post("/", response_model=schemas.OrderOut)
@router.post("", response_model=schemas.OrderOut, include_in_schema=False)
async def create_order(
    order: schemas.OrderCreate,
    request: Request,
    current_user=Depends(auth.get_current_user),
):
    order_out = await run_in_threadpool(
        _create_order_sync,
        current_user.id,
        order,
        request,
    )
    order_summary = _serialize_order_summary(order_out)

    # Notify listeners with lightweight summary data
    await sio.emit("new_order", order_summary)
    await sio.emit("stock_update")

    return order_out


@router.post("/{order_id}/cancel", response_model=schemas.OrderOut)
async def cancel_order(
    order_id: int,
    request: Request,
    current_user=Depends(auth.get_current_user),
):
    order_out, did_cancel = await run_in_threadpool(
        _cancel_order_sync,
        order_id,
        current_user,
        request,
    )
    if did_cancel:
        cancelled_payload = {
            **_serialize_order_summary(order_out),
            "order_id": order_out.id,
        }
        await sio.emit("stock_update")
        await sio.emit("order_cancelled", cancelled_payload)

    return order_out


@router.get("/{order_id}", response_model=schemas.OrderOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = _orders_with_details_query(db).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(404, "Order not found")
    if order.user_id != current_user.id and not current_user.is_manager:
        raise HTTPException(status_code=403, detail="Not authorized to access this order")
    return _serialize_order(order)

@router.put("/{order_id}", response_model=schemas.OrderOut)
def update_order(
    order_id: int,
    status: str,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if not (current_user.is_manager or order.user_id == current_user.id):
        raise HTTPException(status_code=403, detail="Not authorized to update this order")

    if status not in ALLOWED_ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid order status")

    order.status = status
    db.commit()
    updated_order = _get_order_with_details(db, order_id)
    return _serialize_order(updated_order)


@router.get("/", response_model=List[schemas.OrderSummaryOut])
@router.get("", response_model=List[schemas.OrderSummaryOut], include_in_schema=False)
def list_orders(
    response: Response,
    status: Optional[str] = None,
    date_filter: Optional[date] = None,
    limit: int = Query(
        DEFAULT_PAGE_SIZE,
        ge=1,
        le=MAX_PAGE_SIZE,
        description=f"Maximum number of orders to return (1..{MAX_PAGE_SIZE})",
    ),
    offset: int = Query(
        0,
        ge=0,
        description="Number of orders to skip (must be >= 0)",
    ),
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    q = db.query(models.Order.id, models.Order.status, models.Order.created_at)
    if not current_user.is_manager:
        if current_user.id is None:
            q = q.filter(false())
        else:
            q = q.filter(models.Order.user_id == current_user.id)
    if status:
        q = q.filter(models.Order.status == status)
    if date_filter is not None:
        start_dt = datetime.combine(date_filter, time.min)
        next_day_dt = start_dt + timedelta(days=1)
        q = q.filter(
            models.Order.created_at >= start_dt,
            models.Order.created_at < next_day_dt,
        )
    rows = (
        q.order_by(models.Order.created_at.desc(), models.Order.id.desc())
        .offset(offset)
        .limit(limit + 1)
        .all()
    )
    has_more = len(rows) > limit
    response.headers["X-Has-More"] = "true" if has_more else "false"
    return rows[:limit]
