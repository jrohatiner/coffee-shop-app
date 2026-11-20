from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.database import get_db

router = APIRouter()

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100

DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[models.User, Depends(auth.get_current_user)]
LimitQuery = Annotated[
    int,
    Query(
        ge=1,
        le=MAX_PAGE_SIZE,
        description=f"Maximum number of reports to return (1..{MAX_PAGE_SIZE})",
    ),
]
OffsetQuery = Annotated[
    int,
    Query(
        ge=0,
        description="Number of reports to skip (must be >= 0)",
    ),
]


def _list_reports_by_type(
    db: Session,
    response: Response,
    report_type: str,
    limit: int,
    offset: int,
) -> list[models.SalesReport]:
    rows = (
        db.query(models.SalesReport)
        .filter(models.SalesReport.report_type == report_type)
        .order_by(models.SalesReport.created_at.desc(), models.SalesReport.id.desc())
        .offset(offset)
        .limit(limit + 1)
        .all()
    )
    has_more = len(rows) > limit
    response.headers["X-Has-More"] = "true" if has_more else "false"
    return rows[:limit]


@router.get("/daily", response_model=list[schemas.SalesReportOut])
def daily(
    response: Response,
    db: DbSession,
    current_user: CurrentUser,
    limit: LimitQuery = DEFAULT_PAGE_SIZE,
    offset: OffsetQuery = 0,
) -> list[models.SalesReport]:
    return _list_reports_by_type(
        db=db,
        response=response,
        report_type="daily",
        limit=limit,
        offset=offset,
    )


@router.get("/weekly", response_model=list[schemas.SalesReportOut])
def weekly(
    response: Response,
    db: DbSession,
    current_user: CurrentUser,
    limit: LimitQuery = DEFAULT_PAGE_SIZE,
    offset: OffsetQuery = 0,
) -> list[models.SalesReport]:
    return _list_reports_by_type(
        db=db,
        response=response,
        report_type="weekly",
        limit=limit,
        offset=offset,
    )


@router.get("/monthly", response_model=list[schemas.SalesReportOut])
def monthly(
    response: Response,
    db: DbSession,
    current_user: CurrentUser,
    limit: LimitQuery = DEFAULT_PAGE_SIZE,
    offset: OffsetQuery = 0,
) -> list[models.SalesReport]:
    return _list_reports_by_type(
        db=db,
        response=response,
        report_type="monthly",
        limit=limit,
        offset=offset,
    )
