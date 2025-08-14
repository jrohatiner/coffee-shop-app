from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas, auth
from app.database import get_db
from app.auth import get_password_hash

router = APIRouter()

@router.post("/", response_model=schemas.UserOut)
def create_user(
    user: schemas.UserCreate,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    if not current_user.is_manager:
        raise HTTPException(403, "Only managers can create users")
    if db.query(models.User).filter(models.User.username == user.username).first():
        raise HTTPException(400, "Username already exists")

    u = models.User(
        username=user.username,
        hashed_password=get_password_hash(user.password),
        is_manager=user.is_manager,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u

@router.get("/", response_model=List[schemas.UserOut])
def list_users(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    if not current_user.is_manager:
        raise HTTPException(403, "Only managers can view users")
    return db.query(models.User).all()

@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    if not current_user.is_manager:
        raise HTTPException(403, "Only managers can delete users")

    u = db.query(models.User).filter(models.User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")

    db.delete(u)
    db.commit()
    return {"detail": "User deleted"}
