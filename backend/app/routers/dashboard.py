from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import auth, models
from app.database import get_db

router = APIRouter()


@router.get("/summary", response_model=None)
def summary(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[models.User, Depends(auth.get_current_user)],
) -> dict[str, Any]:
    total_sales = 0.0
    recent = (
        db.query(models.Order).order_by(models.Order.created_at.desc()).limit(10).all()
    )
    return {"totalSales": total_sales, "recentOrders": recent}
