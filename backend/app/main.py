from typing import Dict, Optional, Set, Union

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect
from sqlalchemy.engine import Connection, Engine

from .database import Base, engine
from .routers import auth as auth_router, dashboard, orders, inventory, reports, users
from .websockets import init_websockets
from .auth import get_jwt_secret


def _ensure_indexes_on_connection(conn: Connection) -> None:
    inspector = inspect(conn)
    tables_by_schema: Dict[Optional[str], Set[str]] = {}
    for table in Base.metadata.tables.values():
        if table.schema not in tables_by_schema:
            tables_by_schema[table.schema] = set(
                inspector.get_table_names(schema=table.schema)
            )
        if table.name not in tables_by_schema[table.schema]:
            continue

        existing_index_names = {
            idx["name"]
            for idx in inspector.get_indexes(table.name, schema=table.schema)
            if idx.get("name") is not None
        }
        for index in table.indexes:
            if index.name is None:
                index.create(bind=conn, checkfirst=True)
            elif index.name not in existing_index_names:
                index.create(bind=conn, checkfirst=False)
                existing_index_names.add(index.name)


def ensure_indexes(bind_engine: Union[Engine, Connection] = engine) -> None:
    if isinstance(bind_engine, Connection):
        if bind_engine.in_transaction():
            _ensure_indexes_on_connection(bind_engine)
        else:
            with bind_engine.begin():
                _ensure_indexes_on_connection(bind_engine)
    else:
        with bind_engine.begin() as conn:
            _ensure_indexes_on_connection(conn)


with engine.begin() as conn:
    Base.metadata.create_all(bind=conn)
    ensure_indexes(bind_engine=conn)

app = FastAPI(title="Coffee Shop Ordering System", version="1.0.0")

@app.on_event("startup")
def startup_event():
    get_jwt_secret()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
    expose_headers=["X-Has-More"],
)

app.include_router(auth_router.router, prefix="/auth", tags=["Auth"])
app.include_router(dashboard.router, prefix="/dashboard", tags=["Dashboard"])
app.include_router(orders.router, prefix="/orders", tags=["Orders"])
app.include_router(inventory.router, prefix="/inventory", tags=["Inventory"])
app.include_router(reports.router, prefix="/reports", tags=["Reports"])
app.include_router(users.router, prefix="/users", tags=["Users"])

init_websockets(app)
