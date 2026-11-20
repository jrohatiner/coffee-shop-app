# Coffee Shop Ordering System ☕️

Full-stack app:
- Backend: FastAPI, SQLAlchemy, JWT, Socket.IO, Cloud Run ready
- Frontend: Next.js (TypeScript), Tailwind, shadcn-style UI, socket.io-client
- Seed data included

## Run locally

### Backend
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pytest httpx websockets

# Quickstart with default SQLite fallback (creates dev.db when DATABASE_URL is unset)
export JWT_SECRET="local-dev-jwt-secret-key-12345"
python -c "import app.main"
python seed.py
uvicorn app.main:app --reload

# Optional: point DATABASE_URL at local PostgreSQL via .env (copied from .env.example)
# export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/coffee"

# Run backend test suite (matches CI backend-checks)
PYTHONPATH=. python -m pytest -v
```

### Frontend
```bash
cd frontend
npm install --no-package-lock --no-audit --no-fund

# Verify production compilation and TypeScript types (matches CI frontend-build)
npm run build

# Start local dev server on http://localhost:3000
npm run dev
```

See [AGENTS.md](./AGENTS.md) for full local CI and Cloud Build verification commands.
