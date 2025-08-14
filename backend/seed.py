from passlib.context import CryptContext
from sqlalchemy.orm import Session
from app.database import Base, engine, SessionLocal
from app import models

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

def main():
    Base.metadata.create_all(bind=engine)
    db: Session = SessionLocal()
    try:
        if not db.query(models.User).filter_by(username="manager").first():
            db.add(models.User(username="manager", hashed_password=pwd.hash("manager123"), is_manager=True))
        if not db.query(models.User).filter_by(username="staff").first():
            db.add(models.User(username="staff", hashed_password=pwd.hash("staff123"), is_manager=False))
        products = [
            {"name":"Espresso","price":3.0,"stock":100},
            {"name":"Latte","price":4.5,"stock":80},
            {"name":"Cappuccino","price":4.0,"stock":70},
            {"name":"Americano","price":3.5,"stock":90},
            {"name":"Mocha","price":4.8,"stock":60},
        ]
        for p in products:
            if not db.query(models.Product).filter_by(name=p["name"]).first():
                db.add(models.Product(**p))
        db.commit()
        print("Seed complete.")
    finally:
        db.close()

if __name__ == "__main__":
    main()
