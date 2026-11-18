import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./dev.db")
INSTANCE_SOCKET = os.getenv("INSTANCE_UNIX_SOCKET")

if INSTANCE_SOCKET and DATABASE_URL and DATABASE_URL.startswith("postgresql"):
    DATABASE_URL = DATABASE_URL.replace("localhost", f"/cloudsql/{INSTANCE_SOCKET}")

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
else:
    connect_args = {"sslmode": "disable"}

# Create the SQLAlchemy engine
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
