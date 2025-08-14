from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

# ---------- Users ----------
class UserBase(BaseModel):
    username: str
    is_manager: Optional[bool] = False

class UserCreate(UserBase):
    password: str

class UserOut(UserBase):
    id: int
    class Config:
        orm_mode = True

# ---------- Products ----------
class ProductBase(BaseModel):
    name: str
    price: float
    stock: int

class ProductCreate(ProductBase):
    pass

class ProductOut(ProductBase):
    id: int
    class Config:
        orm_mode = True

# ---------- Orders ----------
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
    class Config:
        orm_mode = True

class OrderBase(BaseModel):
    status: Optional[str] = "pending"

class OrderOut(OrderBase):
    id: int
    user_id: int
    created_at: datetime
    items: List[OrderItemOut]
    class Config:
        orm_mode = True

# ---------- Reports ----------
class SalesReportOut(BaseModel):
    id: int
    report_type: str
    total_sales: float
    created_at: datetime
    class Config:
        orm_mode = True

# ---------- Auth ----------
class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: Optional[str] = None
