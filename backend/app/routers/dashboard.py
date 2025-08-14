from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, auth
from app.database import get_db

router = APIRouter()

@router.get("/summary")
def summary(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    total_sales = 0.0
    recent = (
        db.query(models.Order)
        .order_by(models.Order.created_at.desc())
        .limit(10)
        .all()
    )
    return {
        "totalSales": total_sales,
        "recentOrders": recent
    }
