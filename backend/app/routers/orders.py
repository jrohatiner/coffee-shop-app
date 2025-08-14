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
    db_order = models.Order(user_id=order.user_id, status=order.status)
    db.add(db_order)
    db.commit()
    db.refresh(db_order)

    for item in order.items:
        db.add(
            models.OrderItem(
                order_id=db_order.id,
                product_id=item.product_id,
                quantity=item.quantity,
            )
        )
    db.commit()
    db.refresh(db_order)

    await sio.emit("new_order")
    return db_order

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
