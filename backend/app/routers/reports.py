from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, schemas, auth
from app.database import get_db

router = APIRouter()

@router.get("/daily", response_model=List[schemas.SalesReportOut])
def daily(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    return db.query(models.SalesReport).filter(models.SalesReport.report_type == "daily").all()

@router.get("/weekly", response_model=List[schemas.SalesReportOut])
def weekly(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    return db.query(models.SalesReport).filter(models.SalesReport.report_type == "weekly").all()

@router.get("/monthly", response_model=List[schemas.SalesReportOut])
def monthly(
    db: Session = Depends(get_db),
    current_user=Depends(auth.get_current_user),
):
    return db.query(models.SalesReport).filter(models.SalesReport.report_type == "monthly").all()
