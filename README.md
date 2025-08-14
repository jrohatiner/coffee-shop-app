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
# set .env from .env.example and ensure DATABASE_URL points to local Postgres
uvicorn app.main:app --reload
python seed.py
