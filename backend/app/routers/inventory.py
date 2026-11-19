from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app import auth, database, models, schemas
from app.database import get_db
from app.websockets import sio

router = APIRouter()


def _to_product_out(product: models.Product) -> schemas.ProductOut:
    if hasattr(schemas.ProductOut, "model_validate"):
        return schemas.ProductOut.model_validate(product, from_attributes=True)
    return schemas.ProductOut.from_orm(product)


def _dump_product_create(product_in: schemas.ProductCreate) -> dict:
    if hasattr(product_in, "model_dump"):
        return product_in.model_dump()
    return product_in.dict()


def _create_inventory_item_sync(
    product_in: schemas.ProductCreate,
    request: Request,
) -> schemas.ProductOut:
    with database.session_scope(request) as db:
        if db.query(models.Product).filter(models.Product.name == product_in.name).first():
            raise HTTPException(400, "Product name already exists")

        product = models.Product(**_dump_product_create(product_in))
        db.add(product)
        db.commit()
        db.refresh(product)
        return _to_product_out(product)


def _update_inventory_sync(
    product_id: int,
    product_update: schemas.ProductCreate,
    request: Request,
) -> schemas.ProductOut:
    with database.session_scope(request) as db:
        product = db.query(models.Product).filter(models.Product.id == product_id).first()
        if not product:
            raise HTTPException(404, "Product not found")

        product.name = product_update.name
        product.price = product_update.price
        product.stock = product_update.stock

        db.commit()
        db.refresh(product)
        return _to_product_out(product)


def _delete_inventory_item_sync(
    product_id: int,
    request: Request,
) -> Dict[str, str]:
    with database.session_scope(request) as db:
        product = db.query(models.Product).filter(models.Product.id == product_id).first()
        if not product:
            raise HTTPException(404, "Product not found")

        in_use = db.query(models.OrderItem).filter(models.OrderItem.product_id == product_id).first()
        if in_use:
            raise HTTPException(400, "Cannot delete a product used in existing orders")

        db.delete(product)
        db.commit()
        return {"detail": "Product deleted"}


@router.get("/", response_model=List[schemas.ProductOut])
def get_inventory(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    return db.query(models.Product).all()


@router.post("/", response_model=schemas.ProductOut, status_code=201)
async def create_inventory_item(
    product_in: schemas.ProductCreate,
    request: Request,
    current_user=Depends(auth.get_current_user),
):
    # Optional: restrict creation to managers
    # if not current_user.is_manager:
    #     raise HTTPException(403, "Only managers can add products")

    product_out = await run_in_threadpool(_create_inventory_item_sync, product_in, request)
    await sio.emit("stock_update")
    return product_out


@router.put("/{product_id}", response_model=schemas.ProductOut)
async def update_inventory(
    product_id: int,
    product_update: schemas.ProductCreate,
    request: Request,
    current_user=Depends(auth.get_current_user),
):
    product_out = await run_in_threadpool(
        _update_inventory_sync,
        product_id,
        product_update,
        request,
    )
    await sio.emit("stock_update")
    return product_out


@router.delete("/{product_id}")
async def delete_inventory_item(
    product_id: int,
    request: Request,
    current_user=Depends(auth.get_current_user),
):
    # Optional: restrict deletion to managers
    # if not current_user.is_manager:
    #     raise HTTPException(403, "Only managers can delete products")

    result = await run_in_threadpool(_delete_inventory_item_sync, product_id, request)
    await sio.emit("stock_update")
    return result
