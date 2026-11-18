from datetime import date
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app import auth, database, models, schemas
from app.database import get_db
from app.websockets import sio

router = APIRouter()


def _to_order_out(order: models.Order) -> schemas.OrderOut:
    if hasattr(schemas.OrderOut, "model_validate"):
        return schemas.OrderOut.model_validate(order, from_attributes=True)
    return schemas.OrderOut.from_orm(order)


def _create_order_sync(user_id: int, order: schemas.OrderCreate) -> schemas.OrderOut:
    db = database.SessionLocal()
    try:
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

        db_order = models.Order(user_id=user_id, status=order.status)
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
        db.refresh(db_order)
        return _to_order_out(db_order)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _cancel_order_sync(order_id: int) -> Tuple[schemas.OrderOut, bool]:
    db = database.SessionLocal()
    try:
        order = db.query(models.Order).filter(models.Order.id == order_id).first()
        if not order:
            raise HTTPException(404, "Order not found")

        if order.status == "cancelled":
            return _to_order_out(order), False

        # Restock items when cancelling
        for it in order.items:
            prod = db.query(models.Product).filter(models.Product.id == it.product_id).first()
            if prod:
                prod.stock += it.quantity

        order.status = "cancelled"
        db.commit()
        db.refresh(order)
        return _to_order_out(order), True
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@router.post("/", response_model=schemas.OrderOut)
async def create_order(
    order: schemas.OrderCreate,
    current_user=Depends(auth.get_current_user),
):
    order_out = await run_in_threadpool(_create_order_sync, current_user.id, order)

    # Notify listeners
    await sio.emit("new_order")
    await sio.emit("stock_update")

    return order_out


@router.post("/{order_id}/cancel", response_model=schemas.OrderOut)
async def cancel_order(
    order_id: int,
    current_user=Depends(auth.get_current_user),
):
    order_out, did_cancel = await run_in_threadpool(_cancel_order_sync, order_id)
    if did_cancel:
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
    if date_filter:
        q = q.filter(models.Order.created_at.cast(date) == date_filter)  # type: ignore
    return q.all()
