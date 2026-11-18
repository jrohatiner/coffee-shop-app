from datetime import date, datetime, time, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session, joinedload

from app import models, schemas, auth
from app.database import get_db
from app.websockets import sio

router = APIRouter()

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


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


@router.post("/", response_model=schemas.OrderOut)
@router.post("", response_model=schemas.OrderOut, include_in_schema=False)
async def create_order(
    order: schemas.OrderCreate,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    # Batch-fetch referenced products and validate stock first
    product_ids = {item.product_id for item in order.items}
    products = (
        db.query(models.Product).filter(models.Product.id.in_(product_ids)).all()
        if product_ids
        else []
    )
    product_map = {prod.id: prod for prod in products}

    for item in order.items:
        prod = product_map.get(item.product_id)
        if not prod:
            raise HTTPException(400, f"Product {item.product_id} does not exist")
        if item.quantity <= 0:
            raise HTTPException(400, f"Invalid quantity for product {prod.name}")
        if prod.stock < item.quantity:
            raise HTTPException(
                400,
                f"Insufficient stock for {prod.name}. Available: {prod.stock}, requested: {item.quantity}",
            )

    # user_id comes from token
    db_order = models.Order(user_id=current_user.id, status=order.status)
    db.add(db_order)
    db.flush()

    # Deduct stock and create items
    for item in order.items:
        prod = product_map[item.product_id]
        prod.stock -= item.quantity
        db.add(
            models.OrderItem(
                order_id=db_order.id,
                product_id=item.product_id,
                quantity=item.quantity,
            )
        )

    db.commit()
    created_order = _get_order_with_details(db, db_order.id)

    # Notify listeners
    await sio.emit("new_order")
    await sio.emit("stock_update")

    return created_order


@router.post("/{order_id}/cancel", response_model=schemas.OrderOut)
async def cancel_order(
    order_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = _get_order_with_details(db, order_id)
    if not order:
        raise HTTPException(404, "Order not found")

    if order.status == "cancelled":
        return order

    # Restock items when cancelling
    for it in order.items:
        if it.product:
            it.product.stock += it.quantity

    order.status = "cancelled"
    db.commit()
    order = _get_order_with_details(db, order_id)

    await sio.emit("stock_update")
    await sio.emit("order_cancelled", {"order_id": order.id})

    return order


@router.get("/{order_id}", response_model=schemas.OrderOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = _orders_with_details_query(db).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(404, "Order not found")
    return order


@router.put("/{order_id}", response_model=schemas.OrderOut)
def update_order(
    order_id: int,
    status: str,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(404, "Order not found")
    order.status = status
    db.commit()
    return _get_order_with_details(db, order_id)


@router.get("/", response_model=List[schemas.OrderOut])
@router.get("", response_model=List[schemas.OrderOut], include_in_schema=False)
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
    q = _orders_with_details_query(db)
    if status:
        q = q.filter(models.Order.status == status)
    if date_filter:
        start_dt = datetime.combine(date_filter, time.min)
        end_dt = start_dt + timedelta(days=1)
        q = q.filter(
            models.Order.created_at >= start_dt,
            models.Order.created_at < end_dt,
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
