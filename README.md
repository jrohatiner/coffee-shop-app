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
python -m pip install --upgrade pip
pip install --no-cache-dir --require-hashes -r requirements.txt
pip install pytest httpx websockets

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
npm ci

# Verify static analysis, production compilation, and unit tests
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:unit

# Start local dev server on http://localhost:3000
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

See [AGENTS.md](./AGENTS.md) for full local CI, pre-commit, and Cloud Build verification commands.
