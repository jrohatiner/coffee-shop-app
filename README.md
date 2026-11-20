# Coffee Shop Ordering System ☕️

Full-stack app:
- Backend: FastAPI, SQLAlchemy, JWT, Socket.IO, Cloud Run ready
- Frontend: Next.js (TypeScript), Tailwind, shadcn-style UI, socket.io-client
- Seed data included

## Run locally

### Backend
```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install --no-cache-dir --require-hashes -r requirements.txt
# set .env from .env.example and ensure DATABASE_URL points to local Postgres (or SQLite)
uvicorn app.main:app --reload
python seed.py
```

### Frontend
```bash
cd frontend
npm ci
npm run dev
```

## Updating dependencies & lockfiles

### Backend (`backend/requirements.in` -> `backend/requirements.txt`)
Edit version bounds in `backend/requirements.in`, then recompile `backend/requirements.txt` against Python 3.11 (matching `python:3.11-slim` in `backend/Dockerfile`) with SHA-256 hashes:
```bash
docker run --rm -v "$PWD/backend:/work" -w /work python:3.11-slim sh -c \
  "pip install --no-cache-dir pip-tools && pip-compile --generate-hashes --strip-extras --output-file=requirements.txt requirements.in"
```
Or using a local Python 3.11 virtual environment with `pip-tools` installed:
```bash
cd backend
pip-compile --generate-hashes --strip-extras --output-file=requirements.txt requirements.in
```

### Frontend (`frontend/package.json` -> `frontend/package-lock.json`)
Edit `frontend/package.json`, refresh `frontend/package-lock.json`, and verify a clean immutable install:
```bash
cd frontend
npm install --package-lock-only
npm ci
npm run build
```
