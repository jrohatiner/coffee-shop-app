#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="coffee-shop-app"
echo "Creating $APP_ROOT ..."
rm -rf "$APP_ROOT"
mkdir -p "$APP_ROOT"
cd "$APP_ROOT"

#####################################
# Backend
#####################################
mkdir -p backend/app/routers
cat > backend/requirements.txt << 'EOF'
fastapi
uvicorn[standard]
sqlalchemy
psycopg2-binary
python-jose[cryptography]
passlib[bcrypt]
python-dotenv
pydantic
python-socketio[asgi]
EOF

cat > backend/Dockerfile << 'EOF'
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8080
CMD ["uvicorn", "app.main:app", "--host","0.0.0.0","--port","8080"]
EOF

cat > backend/cloudbuild.yaml << 'EOF'
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build','-t','${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend','.']
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push','${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend']
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      [
        'run','deploy','coffee-backend',
        '--image','${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend',
        '--region','${_REGION}',
        '--platform','managed',
        '--allow-unauthenticated',
        '--add-cloudsql-instances','${_CLOUD_SQL_INSTANCE}',
        '--set-env-vars','DATABASE_URL=postgresql://postgres:${_DB_PASS}@localhost:5432/coffee,INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE},JWT_SECRET=${_JWT_SECRET}'
      ]
substitutions:
  _REGION: 'us-central1'
  _CLOUD_SQL_INSTANCE: 'YOUR_PROJECT_ID:us-central1:coffee-db'
  _DB_PASS: 'replace-me'
  _JWT_SECRET: 'replace-me'
EOF

cat > backend/.env.example << 'EOF'
DATABASE_URL=postgresql://postgres:YOUR_DB_PASSWORD@localhost:5432/coffee
INSTANCE_UNIX_SOCKET=YOUR_PROJECT_ID:us-central1:coffee-db
JWT_SECRET=replace-with-strong-random
EOF

# Backend app files
cat > backend/app/__init__.py << 'EOF'
# empty
EOF

# ROBUST database.py (loads .env + SQLite fallback)
cat > backend/app/database.py << 'EOF'
import os
from typing import Optional
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Load .env for local dev
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

DATABASE_URL: Optional[str] = os.getenv("DATABASE_URL")
INSTANCE_SOCKET = os.getenv("INSTANCE_UNIX_SOCKET")

# Fallback to SQLite for quick local runs if DATABASE_URL is not provided
if not DATABASE_URL:
    DATABASE_URL = "sqlite:///./dev.db"

# If using Cloud SQL unix socket on Cloud Run (Postgres), rewrite host
if INSTANCE_SOCKET and DATABASE_URL.startswith("postgresql"):
    DATABASE_URL = DATABASE_URL.replace("localhost", f"/cloudsql/{INSTANCE_SOCKET}")

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()
EOF

cat > backend/app/models.py << 'EOF'
from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, DateTime, Float
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
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey('users.id'))
    status = Column(String, default="pending")
    created_at = Column(DateTime, default=datetime.utcnow)
    user = relationship("User")
    items = relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")

class OrderItem(Base):
    __tablename__ = 'order_items'
    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey('orders.id'))
    product_id = Column(Integer, ForeignKey('products.id'))
    quantity = Column(Integer)
    order = relationship("Order", back_populates="items")
    product = relationship("Product")

class SalesReport(Base):
    __tablename__ = 'sales_reports'
    id = Column(Integer, primary_key=True, index=True)
    report_type = Column(String)  # daily/weekly/monthly
    total_sales = Column(Float)
    created_at = Column(DateTime, default=datetime.utcnow)
EOF

cat > backend/app/schemas.py << 'EOF'
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

class UserBase(BaseModel):
    username: str
    is_manager: Optional[bool] = False

class UserCreate(UserBase):
    password: str

class UserOut(UserBase):
    id: int
    class Config: orm_mode = True

class ProductBase(BaseModel):
    name: str
    price: float
    stock: int

class ProductCreate(ProductBase): pass

class ProductOut(ProductBase):
    id: int
    class Config: orm_mode = True

class OrderItemBase(BaseModel):
    product_id: int
    quantity: int

class OrderItemCreate(OrderItemBase): pass

class OrderItemOut(OrderItemBase):
    id: int
    product: ProductOut
    class Config: orm_mode = True

class OrderBase(BaseModel):
    user_id: int
    status: Optional[str] = "pending"

class OrderCreate(OrderBase):
    items: List[OrderItemCreate]

class OrderOut(OrderBase):
    id: int
    created_at: datetime
    items: List[OrderItemOut]
    class Config: orm_mode = True

class SalesReportOut(BaseModel):
    id: int
    report_type: str
    total_sales: float
    created_at: datetime
    class Config: orm_mode = True

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: Optional[str] = None
EOF

cat > backend/app/auth.py << 'EOF'
from datetime import datetime, timedelta
from typing import Optional
from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from . import schemas, models
from .database import SessionLocal
import os

SECRET_KEY = os.getenv("JWT_SECRET", "dev_secret_key")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")

def verify_password(plain, hashed): return pwd_context.verify(plain, hashed)
def get_password_hash(password): return pwd_context.hash(password)

def authenticate_user(db: Session, username: str, password: str):
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user or not verify_password(password, user.hashed_password): return False
    return user

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(SessionLocal)):
    cred_exc = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials", headers={"WWW-Authenticate":"Bearer"})
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None: raise cred_exc
        token_data = schemas.TokenData(username=username)
    except JWTError:
        raise cred_exc
    user = db.query(models.User).filter(models.User.username == token_data.username).first()
    if user is None: raise cred_exc
    return user
EOF

cat > backend/app/websockets.py << 'EOF'
from fastapi import FastAPI
from socketio import AsyncServer
from socketio.asgi import ASGIApp

sio = AsyncServer(async_mode='asgi', cors_allowed_origins='*')
socket_app = ASGIApp(sio)

def init_websockets(app: FastAPI):
    app.mount('/ws', socket_app)

@sio.event
async def connect(sid, environ): print(f"Client connected: {sid}")

@sio.event
async def disconnect(sid): print(f"Client disconnected: {sid}")
EOF

# Routers
cat > backend/app/routers/auth.py << 'EOF'
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from .. import schemas, auth
from ..database import SessionLocal

router = APIRouter()

@router.post("/token", response_model=schemas.Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(SessionLocal)):
    user = auth.authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect username or password")
    token = auth.create_access_token({"sub": user.username})
    return {"access_token": token, "token_type": "bearer"}

@router.get("/me", response_model=schemas.UserOut)
def me(current_user=Depends(auth.get_current_user)): return current_user
EOF

cat > backend/app/routers/orders.py << 'EOF'
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import date
from .. import models, schemas, auth
from ..database import SessionLocal
from ..websockets import sio

router = APIRouter()

@router.post("/", response_model=schemas.OrderOut)
async def create_order(order: schemas.OrderCreate, db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    db_order = models.Order(user_id=order.user_id, status=order.status)
    db.add(db_order); db.commit(); db.refresh(db_order)
    for item in order.items:
        db.add(models.OrderItem(order_id=db_order.id, product_id=item.product_id, quantity=item.quantity))
    db.commit(); db.refresh(db_order)
    await sio.emit("new_order")
    return db_order

@router.get("/{order_id}", response_model=schemas.OrderOut)
def get_order(order_id: int, db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order: raise HTTPException(404, "Order not found")
    return order

@router.put("/{order_id}", response_model=schemas.OrderOut)
def update_order(order_id: int, status: str, db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order: raise HTTPException(404, "Order not found")
    order.status = status; db.commit(); db.refresh(order)
    return order

@router.get("/", response_model=List[schemas.OrderOut])
def list_orders(status: Optional[str] = None, date_filter: Optional[date] = None, db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    q = db.query(models.Order)
    if status: q = q.filter(models.Order.status == status)
    if date_filter: q = q.filter(models.Order.created_at.cast(date) == date_filter)
    return q.all()
EOF

cat > backend/app/routers/inventory.py << 'EOF'
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from .. import models, schemas, auth
from ..database import SessionLocal
from ..websockets import sio

router = APIRouter()

@router.get("/", response_model=List[schemas.ProductOut])
def get_inventory(db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    return db.query(models.Product).all()

@router.put("/{product_id}", response_model=schemas.ProductOut)
async def update_inventory(product_id: int, product_update: schemas.ProductCreate, db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    product = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not product: raise HTTPException(404, "Product not found")
    product.name = product_update.name; product.price = product_update.price; product.stock = product_update.stock
    db.commit(); db.refresh(product)
    await sio.emit("stock_update")
    return product
EOF

cat > backend/app/routers/reports.py << 'EOF'
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import List
from .. import models, schemas, auth
from ..database import SessionLocal

router = APIRouter()

@router.get("/daily", response_model=List[schemas.SalesReportOut])
def daily(db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    return db.query(models.SalesReport).filter(models.SalesReport.report_type=="daily").all()

@router.get("/weekly", response_model=List[schemas.SalesReportOut])
def weekly(db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    return db.query(models.SalesReport).filter(models.SalesReport.report_type=="weekly").all()

@router.get("/monthly", response_model=List[schemas.SalesReportOut])
def monthly(db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    return db.query(models.SalesReport).filter(models.SalesReport.report_type=="monthly").all()
EOF

cat > backend/app/routers/users.py << 'EOF'
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from .. import models, schemas, auth
from ..database import SessionLocal
from ..auth import get_password_hash

router = APIRouter()

@router.post("/", response_model=schemas.UserOut)
def create_user(user: schemas.UserCreate, db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    if not current_user.is_manager: raise HTTPException(403, "Only managers can create users")
    if db.query(models.User).filter(models.User.username==user.username).first():
        raise HTTPException(400, "Username already exists")
    u = models.User(username=user.username, hashed_password=get_password_hash(user.password), is_manager=user.is_manager)
    db.add(u); db.commit(); db.refresh(u); return u

@router.get("/", response_model=List[schemas.UserOut])
def list_users(db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    if not current_user.is_manager: raise HTTPException(403, "Only managers can view users")
    return db.query(models.User).all()

@router.delete("/{user_id}")
def delete_user(user_id: int, db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    if not current_user.is_manager: raise HTTPException(403, "Only managers can delete users")
    u = db.query(models.User).filter(models.User.id==user_id).first()
    if not u: raise HTTPException(404, "User not found")
    db.delete(u); db.commit(); return {"detail":"User deleted"}
EOF

cat > backend/app/routers/dashboard.py << 'EOF'
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from .. import models, auth
from ..database import SessionLocal

router = APIRouter()

@router.get("/summary")
def summary(db: Session = Depends(SessionLocal), current_user=Depends(auth.get_current_user)):
    total_sales = 0.0
    recent = db.query(models.Order).order_by(models.Order.created_at.desc()).limit(10).all()
    return {"totalSales": total_sales, "recentOrders": recent}
EOF

cat > backend/app/main.py << 'EOF'
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .database import Base, engine
from . import models
from .routers import auth as auth_router, dashboard, orders, inventory, reports, users
from .websockets import init_websockets

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Coffee Shop Ordering System", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

app.include_router(auth_router.router, prefix="/auth", tags=["Auth"])
app.include_router(dashboard.router, prefix="/dashboard", tags=["Dashboard"])
app.include_router(orders.router, prefix="/orders", tags=["Orders"])
app.include_router(inventory.router, prefix="/inventory", tags=["Inventory"])
app.include_router(reports.router, prefix="/reports", tags=["Reports"])
app.include_router(users.router, prefix="/users", tags=["Users"])

init_websockets(app)
EOF

cat > backend/seed.py << 'EOF'
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
EOF

#####################################
# Frontend (Next.js TS + Tailwind + shadcn-style)
#####################################
mkdir -p frontend/pages frontend/components/ui frontend/hooks frontend/lib frontend/styles

cat > frontend/package.json << 'EOF'
{
  "name": "coffee-shop-frontend",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start",
    "export": "next export"
  },
  "dependencies": {
    "axios": "^1.6.7",
    "clsx": "^2.0.0",
    "jwt-decode": "^4.0.0",
    "next": "14.1.0",
    "react": "18.2.0",
    "react-dom": "18.2.0",
    "socket.io-client": "^4.7.2",
    "tailwind-merge": "^2.3.0"
  },
  "devDependencies": {
    "autoprefixer": "^10.4.17",
    "postcss": "^8.4.35",
    "tailwindcss": "^3.4.3",
    "typescript": "^5.4.0"
  }
}
EOF

cat > frontend/next.config.js << 'EOF'
/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true, output: 'standalone' }
module.exports = nextConfig
EOF

cat > frontend/tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "es6",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": false,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "baseUrl": ".",
    "paths": { "@/*": ["*"] }
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
EOF

cat > frontend/postcss.config.js << 'EOF'
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } }
EOF

cat > frontend/tailwind.config.js << 'EOF'
module.exports = {
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: []
}
EOF

cat > frontend/styles/globals.css << 'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;

body { @apply bg-gray-50 text-gray-900; }
EOF

# Simple shadcn-style primitives
cat > frontend/components/ui/Button.tsx << 'EOF'
import React from 'react'
export const Button = ({children, className='', ...props}: React.ButtonHTMLAttributes<HTMLButtonElement> & {className?:string}) => (
  <button className={`px-3 py-2 border rounded hover:bg-gray-100 ${className}`} {...props}>{children}</button>
)
export default Button
EOF

cat > frontend/components/ui/Input.tsx << 'EOF'
import React from 'react'
export const Input = ({className='', ...props}: React.InputHTMLAttributes<HTMLInputElement> & {className?:string}) => (
  <input className={`border rounded px-3 py-2 w-full ${className}`} {...props} />
)
export default Input
EOF

cat > frontend/components/ui/Dialog.tsx << 'EOF'
import React from 'react'
export const Dialog = ({open, onOpenChange, children}:{open:boolean;onOpenChange:()=>void;children:React.ReactNode}) => {
  if(!open) return null
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={onOpenChange}>
      <div className="bg-white rounded shadow p-4 min-w-[320px]" onClick={(e)=>e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
export default Dialog
EOF

cat > frontend/components/ui/Tabs.tsx << 'EOF'
import React from 'react'
export const Tabs = ({value,onValueChange,children}:{value:string;onValueChange:(v:string)=>void;children:React.ReactNode}) => <div>{children}</div>
export const TabsList = ({children}:{children:React.ReactNode}) => <div className="flex gap-2">{children}</div>
export const TabsTrigger = ({value,children,onClick}:{value:string;children:React.ReactNode;onClick?:()=>void}) => (
  <button className="px-2 py-1 border rounded" onClick={onClick}>{children}</button>
)
export const TabsContent = ({children}:{children:React.ReactNode}) => <div>{children}</div>
export default Tabs
EOF

cat > frontend/components/ui/Table.tsx << 'EOF'
import React from 'react'
export const Table = ({children}:{children:React.ReactNode}) => <table className="w-full border">{children}</table>
export default Table
EOF

cat > frontend/components/ui/toaster.tsx << 'EOF'
export const Toaster = () => null
EOF

cat > frontend/components/ui/use-toast.ts << 'EOF'
export const toast = ({ title, description, variant='default' }:{title:string;description?:string;variant?:'default'|'destructive'}) => {
  const tag = variant==='destructive' ? '❌' : '✅'
  console.log(`${tag} ${title}${description?': '+description:''}`)
}
EOF

# App components
cat > frontend/components/OrderDetailModal.tsx << 'EOF'
'use client'
import Dialog from './ui/Dialog'
export default function OrderDetailModal({ order, onClose }: any) {
  return (
    <Dialog open={!!order} onOpenChange={onClose}>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Order #{order.id}</h2>
        <div>Status: {order.status}</div>
        <div>Items:</div>
        <ul className="list-disc ml-5">
          {order.items?.map((it:any)=>(
            <li key={it.id}>{it.product?.name ?? 'Item'} × {it.quantity}</li>
          ))}
        </ul>
        <button className="mt-3 px-3 py-2 border rounded" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  )
}
EOF

# lib + hooks
cat > frontend/lib/api.ts << 'EOF'
import axios from 'axios'
const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000' })
api.interceptors.request.use((cfg)=>{
  if(typeof window !== 'undefined'){
    const token = localStorage.getItem('token')
    if(token && cfg.headers) cfg.headers.Authorization = `Bearer ${token}`
  }
  return cfg
})
export default api
EOF

cat > frontend/hooks/useAuth.ts << 'EOF'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import jwt_decode from 'jwt-decode'
type Decoded = { exp:number; sub:string }
export const useAuth = () => {
  const [user,setUser] = useState<Decoded|null>(null)
  const r = useRouter()
  useEffect(()=>{
    const t = localStorage.getItem('token')
    if(!t){ r.push('/login'); return }
    const d = jwt_decode<Decoded>(t)
    if(d.exp*1000 < Date.now()){ localStorage.removeItem('token'); r.push('/login'); return }
    setUser(d)
  },[r])
  return user
}
EOF

cat > frontend/hooks/useSocket.ts << 'EOF'
import { useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
export const useSocket = (onReady?: (socket:Socket)=>void) => {
  const ref = useRef<Socket|null>(null)
  useEffect(()=>{
    const s = io('/ws', { path: '/ws/' })
    ref.current = s
    onReady && onReady(s)
    return ()=>{ s.disconnect() }
  },[onReady])
  return ref
}
EOF

# Pages
cat > frontend/pages/_app.tsx << 'EOF'
import '../styles/globals.css'
import type { AppProps } from 'next/app'
import { Toaster } from '../components/ui/toaster'
export default function App({ Component, pageProps }: AppProps){
  return (<>
    <Component {...pageProps} />
    <Toaster />
  </>)
}
EOF

cat > frontend/pages/index.tsx << 'EOF'
import Link from 'next/link'
export default function Home(){
  return (
    <main className="p-6 space-y-2">
      <h1 className="text-3xl font-bold mb-4">Coffee Shop Admin</h1>
      <ul className="space-y-2">
        <li><Link className="underline text-blue-600" href="/dashboard">Dashboard</Link></li>
        <li><Link className="underline text-blue-600" href="/orders">Orders</Link></li>
        <li><Link className="underline text-blue-600" href="/inventory">Inventory</Link></li>
        <li><Link className="underline text-blue-600" href="/reports">Reports</Link></li>
        <li><Link className="underline text-blue-600" href="/users">User Management</Link></li>
      </ul>
    </main>
  )
}
EOF

cat > frontend/pages/login.tsx << 'EOF'
'use client'
import { useState } from 'react'
import { useRouter } from 'next/router'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/use-toast'

export default function Login(){
  const r = useRouter()
  const [username,setU]=useState(''); const [password,setP]=useState('')
  const submit = async ()=>{
    try{
      const form = new URLSearchParams({username,password})
      const res = await api.post('/auth/token', form, { headers: {'Content-Type':'application/x-www-form-urlencoded'} })
      localStorage.setItem('token', res.data.access_token)
      r.push('/dashboard')
    }catch(e){ toast({ title:'Login failed', description:'Invalid credentials', variant:'destructive'}) }
  }
  return (
    <main className="p-6 max-w-md mx-auto space-y-3">
      <h1 className="text-2xl font-bold">Login</h1>
      <Input placeholder="Username" value={username} onChange={e=>setU((e.target as HTMLInputElement).value)} />
      <Input placeholder="Password" type="password" value={password} onChange={e=>setP((e.target as HTMLInputElement).value)} />
      <Button onClick={submit}>Sign in</Button>
    </main>
  )
}
EOF

cat > frontend/pages/dashboard.tsx << 'EOF'
'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'

export default function Dashboard(){
  const user = useAuth()
  const [summary,setSummary]=useState<any>({ totalSales:0, recentOrders:[] })
  useEffect(()=>{ if(user) api.get('/dashboard/summary').then(r=>setSummary(r.data)) },[user])
  if(!user) return null
  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="p-4 border rounded">
        <h2 className="font-semibold">Total Sales</h2>
        <div className="text-2xl">${summary.totalSales?.toFixed?.(2) ?? 0}</div>
      </div>
      <div className="p-4 border rounded">
        <h2 className="font-semibold">Recent Orders</h2>
        <ul className="list-disc ml-5">
          {summary.recentOrders?.map((o:any)=>(
            <li key={o.id}>#{o.id} — {o.status} — {new Date(o.created_at).toLocaleString()}</li>
          ))}
        </ul>
      </div>
    </main>
  )
}
EOF

cat > frontend/pages/orders.tsx << 'EOF'
'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Button from '../components/ui/Button'
import { Table } from '../components/ui/Table'
import OrderDetailModal from '../components/OrderDetailModal'
import { useSocket } from '../hooks/useSocket'

export default function Orders(){
  const user = useAuth()
  const [orders,setOrders]=useState<any[]>([])
  const [selected,setSelected]=useState<any|null>(null)
  const fetchOrders=()=>api.get('/orders').then(r=>setOrders(r.data)).catch(()=>toast({title:'Error', description:'Failed to load orders', variant:'destructive'}))
  useEffect(()=>{ if(user) fetchOrders() },[user])
  useSocket(s=>{ s.on('new_order', ()=>{ toast({title:'New Order'}); fetchOrders() }) })
  if(!user) return null
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-4">Orders</h1>
      <Table>
        <thead><tr><th>ID</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
        <tbody>
          {orders.map(o=>(
            <tr key={o.id}>
              <td>{o.id}</td><td>{o.status}</td><td>{new Date(o.created_at).toLocaleString()}</td>
              <td><Button onClick={()=>setSelected(o)}>View</Button></td>
            </tr>
          ))}
        </tbody>
      </Table>
      {selected && <OrderDetailModal order={selected} onClose={()=>setSelected(null)} />}
    </main>
  )
}
EOF

cat > frontend/pages/inventory.tsx << 'EOF'
'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { toast } from '../components/ui/use-toast'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { useSocket } from '../hooks/useSocket'

export default function Inventory(){
  const user = useAuth()
  const [products,setProducts]=useState<any[]>([])
  const load=()=>api.get('/inventory').then(r=>setProducts(r.data))
  useEffect(()=>{ if(user) load() },[user])
  useSocket(s=>{ s.on('stock_update', ()=>{ toast({title:'Inventory Changed'}); load() }) })
  if(!user) return null
  const save = async (p:any) => {
    try{ await api.put(`/inventory/${p.id}`, p); toast({title:'Saved', description:p.name}) ; load() }
    catch{ toast({title:'Error', description:'Failed to save', variant:'destructive'}) }
  }
  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Inventory</h1>
      {products.map(p=>(
        <div key={p.id} className="border rounded p-4 space-y-2">
          <Input defaultValue={p.name} onChange={e=>p.name=(e.target as HTMLInputElement).value} />
          <Input type="number" defaultValue={p.price} onChange={e=>p.price=parseFloat((e.target as HTMLInputElement).value)} />
          <Input type="number" defaultValue={p.stock} onChange={e=>p.stock=parseInt((e.target as HTMLInputElement).value)} />
          <Button onClick={()=>save(p)}>Save</Button>
        </div>
      ))}
    </main>
  )
}
EOF

cat > frontend/pages/reports.tsx << 'EOF'
'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'

export default function Reports(){
  const user = useAuth()
  const [tab,setTab]=useState<'daily'|'weekly'|'monthly'>('daily')
  const [reports,setReports]=useState<any[]>([])
  useEffect(()=>{ if(user) api.get(`/reports/${tab}`).then(r=>setReports(r.data)) },[user,tab])
  if(!user) return null
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-4">Sales Reports</h1>
      <Tabs value={tab} onValueChange={(v)=>setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="daily" onClick={()=>setTab('daily')}>Daily</TabsTrigger>
          <TabsTrigger value="weekly" onClick={()=>setTab('weekly')}>Weekly</TabsTrigger>
          <TabsTrigger value="monthly" onClick={()=>setTab('monthly')}>Monthly</TabsTrigger>
        </TabsList>
        <TabsContent>
          <ul className="mt-4 space-y-2">
            {reports.map(r=>(
              <li key={r.id} className="border rounded p-3">
                <strong>{r.report_type.toUpperCase()}</strong> — ${r.total_sales?.toFixed?.(2) ?? 0}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </main>
  )
}
EOF

cat > frontend/pages/users.tsx << 'EOF'
'use client'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useState } from 'react'
import api from '../lib/api'
import Input from '../components/ui/Input'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/use-toast'

export default function Users(){
  const user = useAuth()
  const [users,setUsers]=useState<any[]>([])
  const [form,setForm]=useState({ username:'', password:'', is_manager:false })
  const load=()=>api.get('/users').then(r=>setUsers(r.data)).catch(()=>toast({title:'Error', description:'Manager only', variant:'destructive'}))
  useEffect(()=>{ if(user) load() },[user])
  if(!user) return null
  const create=async()=>{
    try{ await api.post('/users', form); toast({title:'User created', description:form.username}); setForm({username:'',password:'',is_manager:false}); load() }
    catch{ toast({title:'Error', description:'Failed to create', variant:'destructive'}) }
  }
  const del=async(id:number)=>{
    try{ await api.delete(`/users/${id}`); toast({title:'User deleted'}); load() }
    catch{ toast({title:'Error', description:'Failed to delete', variant:'destructive'}) }
  }
  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>
      <div className="border rounded p-4 space-y-2">
        <h2 className="font-semibold">Create</h2>
        <Input placeholder="Username" value={form.username} onChange={e=>setForm({...form, username:(e.target as HTMLInputElement).value})}/>
        <Input placeholder="Password" type="password" value={form.password} onChange={e=>setForm({...form, password:(e.target as HTMLInputElement).value})}/>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.is_manager} onChange={e=>setForm({...form, is_manager:(e.target as HTMLInputElement).checked})}/>
          <span>Manager</span>
        </label>
        <Button onClick={create}>Create User</Button>
      </div>
      <div className="border rounded p-4 space-y-2">
        <h2 className="font-semibold">Existing</h2>
        <ul className="space-y-2">
          {users.map(u=>(
            <li key={u.id} className="flex justify-between items-center">
              <span>{u.username} {u.is_manager ? '(Manager)' : ''}</span>
              <Button onClick={()=>del(u.id)}>Delete</Button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
EOF

cat > frontend/firebase.json << 'EOF'
{
  "hosting": { "public": "out", "ignore": ["**/.*","**/node_modules/**"] }
}
EOF

cat > frontend/.firebaserc << 'EOF'
{
  "projects": { "default": "YOUR_FIREBASE_PROJECT_ID" }
}
EOF

# Root README (CLOSED HEREDOC)
cat > README.md << 'EOF'
# Coffee Shop Ordering System ☕️

Full-stack app:
- Backend: FastAPI, SQLAlchemy, JWT, Socket.IO, Cloud Run ready
- Frontend: Next.js (TypeScript), Tailwind, shadcn-style UI, socket.io-client
- Seed data included

## Run locally

### Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Option A: Use local Postgres (Docker)
echo "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coffee" > .env
echo "JWT_SECRET=dev-secret" >> .env

python -m seed
uvicorn app.main:app --reload
