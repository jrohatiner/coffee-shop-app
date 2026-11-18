import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.getenv("DATABASE_URL")
INSTANCE_SOCKET = os.getenv("INSTANCE_UNIX_SOCKET")

if INSTANCE_SOCKET and DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("localhost", f"/cloudsql/{INSTANCE_SOCKET}")

# Create the SQLAlchemy engine
connect_args = (
    {"check_same_thread": False}
    if DATABASE_URL and DATABASE_URL.startswith("sqlite")
    else {"sslmode": "disable"}
)
engine = create_engine(DATABASE_URL, connect_args=connect_args)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for models
Base = declarative_base()

# Dependency to provide a DB session to FastAPI routes
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
