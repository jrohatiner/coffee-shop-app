from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict

# ---------- Users ----------
class UserBase(BaseModel):
    username: str
    is_manager: Optional[bool] = False

class UserCreate(UserBase):
    password: str

class UserOut(UserBase):
    id: int
    model_config = ConfigDict(from_attributes=True)

# ---------- Products ----------
class ProductBase(BaseModel):
    name: str
    price: float
    stock: int

class ProductCreate(ProductBase):
    pass

class ProductOut(ProductBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


class StockDeltaOut(BaseModel):
    updated: List[ProductOut] = []
    deleted_ids: List[int] = []

# ---------- Orders ----------
class OrderStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"

class OrderItemBase(BaseModel):
    product_id: int
    quantity: int

class OrderItemCreate(OrderItemBase):
    pass

# Order creation no longer requires user_id; we take it from token
class OrderCreate(BaseModel):
    status: Optional[str] = "pending"
    items: List[OrderItemCreate]

class OrderItemOut(OrderItemBase):
    id: int
    product: ProductOut
    model_config = ConfigDict(from_attributes=True)

class OrderBase(BaseModel):
    status: Optional[str] = "pending"

class OrderSummaryOut(BaseModel):
    id: int
    status: Optional[str] = "pending"
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

class OrderOut(OrderBase):
    id: int
    user_id: Optional[int] = None
    created_at: datetime
    items: List[OrderItemOut]
    model_config = ConfigDict(from_attributes=True)

# ---------- Reports ----------
class SalesReportOut(BaseModel):
    id: int
    report_type: str
    total_sales: float
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

# ---------- Auth ----------
class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: Optional[str] = None
