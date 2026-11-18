from datetime import date, datetime, time, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.attributes import set_committed_value

from app import models, schemas, auth
from app.database import get_db
from app.websockets import sio

router = APIRouter()


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


@router.post("/", response_model=schemas.OrderOut)
async def create_order(
    order: schemas.OrderCreate,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
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

    db_order = models.Order(user_id=current_user.id, status=order.status)
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

    # Notify listeners
    await sio.emit("new_order")
    await sio.emit("stock_update")

    return order_out


@router.post("/{order_id}/cancel", response_model=schemas.OrderOut)
async def cancel_order(
    order_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = (
        db.query(models.Order)
        .options(selectinload(models.Order.items))
        .filter(models.Order.id == order_id)
        .first()
    )
    if not order:
        raise HTTPException(404, "Order not found")

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
        return _serialize_order(order)

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

    await sio.emit("stock_update")
    await sio.emit("order_cancelled", {"order_id": order_out.id})

    return order_out

@router.get("/{order_id}", response_model=schemas.OrderOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
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
    db.refresh(order)
    return order

@router.get("/", response_model=List[schemas.OrderOut])
def list_orders(
    status: Optional[str] = None,
    date_filter: Optional[date] = None,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    q = db.query(models.Order)
    if status:
        q = q.filter(models.Order.status == status)
    if date_filter is not None:
        start_dt = datetime.combine(date_filter, time.min)
        next_day_dt = start_dt + timedelta(days=1)
        q = q.filter(
            models.Order.created_at >= start_dt,
            models.Order.created_at < next_day_dt,
        )
    return q.all()
