from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.database import get_db

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[models.User, Depends(auth.get_current_user)]


@router.get("/daily", response_model=list[schemas.SalesReportOut])
def daily(
    db: DbSession,
    current_user: CurrentUser,
) -> list[models.SalesReport]:
    return (
        db.query(models.SalesReport)
        .filter(models.SalesReport.report_type == "daily")
        .all()
    )


@router.get("/weekly", response_model=list[schemas.SalesReportOut])
def weekly(
    db: DbSession,
    current_user: CurrentUser,
) -> list[models.SalesReport]:
    return (
        db.query(models.SalesReport)
        .filter(models.SalesReport.report_type == "weekly")
        .all()
    )


@router.get("/monthly", response_model=list[schemas.SalesReportOut])
def monthly(
    db: DbSession,
    current_user: CurrentUser,
) -> list[models.SalesReport]:
    return (
        db.query(models.SalesReport)
        .filter(models.SalesReport.report_type == "monthly")
        .all()
    )
