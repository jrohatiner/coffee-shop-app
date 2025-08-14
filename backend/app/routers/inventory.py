from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas, auth
from app.database import get_db
from app.websockets import sio

router = APIRouter()

@router.get("/", response_model=List[schemas.ProductOut])
def get_inventory(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    return db.query(models.Product).all()

@router.post("/", response_model=schemas.ProductOut, status_code=201)
async def create_inventory_item(
    product_in: schemas.ProductCreate,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    # Optional: restrict creation to managers
    # if not current_user.is_manager:
    #     raise HTTPException(403, "Only managers can add products")

    if db.query(models.Product).filter(models.Product.name == product_in.name).first():
        raise HTTPException(400, "Product name already exists")

    product = models.Product(**product_in.dict())
    db.add(product)
    db.commit()
    db.refresh(product)

    await sio.emit("stock_update")
    return product

@router.put("/{product_id}", response_model=schemas.ProductOut)
async def update_inventory(
    product_id: int,
    product_update: schemas.ProductCreate,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    product = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not product:
        raise HTTPException(404, "Product not found")

    product.name = product_update.name
    product.price = product_update.price
    product.stock = product_update.stock

    db.commit()
    db.refresh(product)

    await sio.emit("stock_update")
    return product

@router.delete("/{product_id}")
async def delete_inventory_item(
    product_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    # Optional: restrict deletion to managers
    # if not current_user.is_manager:
    #     raise HTTPException(403, "Only managers can delete products")

    product = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not product:
        raise HTTPException(404, "Product not found")

    # Optional: prevent delete if referenced by order items
    in_use = db.query(models.OrderItem).filter(models.OrderItem.product_id == product_id).first()
    if in_use:
        raise HTTPException(400, "Cannot delete a product used in existing orders")

    db.delete(product)
    db.commit()

    await sio.emit("stock_update")
    return {"detail": "Product deleted"}
