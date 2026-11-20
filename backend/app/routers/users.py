from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.auth import get_password_hash
from app.database import get_db

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[models.User, Depends(auth.get_current_user)]


@router.post("/", response_model=schemas.UserOut)
def create_user(
    user: schemas.UserCreate,
    db: DbSession,
    current_user: CurrentUser,
) -> models.User:
    try:
        if not current_user.is_manager:
            raise HTTPException(403, "Only managers can create users")
        if db.query(models.User).filter(models.User.username == user.username).first():
            raise HTTPException(400, "Username already exists")
    finally:
        db.close()

    hashed_password = get_password_hash(user.password)

    u = models.User(
        username=user.username,
        hashed_password=hashed_password,
        is_manager=bool(user.is_manager),
    )
    try:
        db.add(u)
        db.commit()
        db.refresh(u)
        db.expunge(u)
    except IntegrityError as err:
        db.rollback()
        raise HTTPException(400, "Username already exists") from err
    finally:
        db.close()
    return u


@router.get("/", response_model=list[schemas.UserOut])
def list_users(
    db: DbSession,
    current_user: CurrentUser,
) -> list[models.User]:
    if not current_user.is_manager:
        raise HTTPException(403, "Only managers can view users")
    return db.query(models.User).all()


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    db: DbSession,
    current_user: CurrentUser,
) -> dict[str, str]:
    if not current_user.is_manager:
        raise HTTPException(403, "Only managers can delete users")

    u = db.query(models.User).filter(models.User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")

    db.delete(u)
    db.commit()
    return {"detail": "User deleted"}
