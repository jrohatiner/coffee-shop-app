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
