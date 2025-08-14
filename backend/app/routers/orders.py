from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas, auth
from app.database import get_db
from app.websockets import sio

router = APIRouter()

@router.post("/", response_model=schemas.OrderOut)
async def create_order(
    order: schemas.OrderCreate,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    # user_id comes from token
    db_order = models.Order(user_id=current_user.id, status=order.status)
    db.add(db_order)
    db.commit()
    db.refresh(db_order)

    # Validate stock first
    product_map = {}  # cache products by id
    for item in order.items:
        prod = product_map.get(item.product_id) or db.query(models.Product).filter(models.Product.id == item.product_id).first()
        if not prod:
            raise HTTPException(400, f"Product {item.product_id} does not exist")
        product_map[item.product_id] = prod
        if item.quantity <= 0:
            raise HTTPException(400, f"Invalid quantity for product {prod.name}")
        if prod.stock < item.quantity:
            raise HTTPException(400, f"Insufficient stock for {prod.name}. Available: {prod.stock}, requested: {item.quantity}")

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
    db.refresh(db_order)

    # Notify listeners
    await sio.emit("new_order")
    await sio.emit("stock_update")

    return db_order

@router.post("/{order_id}/cancel", response_model=schemas.OrderOut)
async def cancel_order(
    order_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(404, "Order not found")

    if order.status == "cancelled":
        return order

    # Restock items when cancelling
    for it in order.items:
        prod = db.query(models.Product).filter(models.Product.id == it.product_id).first()
        if prod:
            prod.stock += it.quantity

    order.status = "cancelled"
    db.commit()
    db.refresh(order)

    await sio.emit("stock_update")
    await sio.emit("order_cancelled", {"order_id": order.id})

    return order

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
    if date_filter:
        q = q.filter(models.Order.created_at.cast(date) == date_filter)  # type: ignore
    return q.all()
