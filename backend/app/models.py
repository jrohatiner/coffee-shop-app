from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, DateTime, Float, Index
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    is_manager = Column(Boolean, default=False)

class Product(Base):
    __tablename__ = 'products'
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True)
    price = Column(Float)
    stock = Column(Integer)

class Order(Base):
    __tablename__ = 'orders'
    __table_args__ = (
        Index("ix_orders_status_created_at", "status", "created_at"),
    )
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey('users.id'), index=True)
    status = Column(String, default="pending")
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    user = relationship("User")
    items = relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")

class OrderItem(Base):
    __tablename__ = 'order_items'
    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey('orders.id'), index=True)
    product_id = Column(Integer, ForeignKey('products.id'), index=True)
    quantity = Column(Integer)
    order = relationship("Order", back_populates="items")
    product = relationship("Product")

class SalesReport(Base):
    __tablename__ = 'sales_reports'
    __table_args__ = (
        Index("ix_sales_reports_report_type_created_at", "report_type", "created_at"),
    )
    id = Column(Integer, primary_key=True, index=True)
    report_type = Column(String)  # daily/weekly/monthly
    total_sales = Column(Float)
    created_at = Column(DateTime, default=datetime.utcnow)
