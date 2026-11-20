# AGENTS.md

## Repository Overview
Full-stack Coffee Shop Ordering System:
- `backend/`: FastAPI, SQLAlchemy 2.0.x, Passlib/bcrypt, python-jose, and python-socketio running on Python 3.11 (`python:3.11-slim` in `backend/Dockerfile`).
- `frontend/`: Next.js `14.1.0` (Pages Router, TypeScript), Tailwind CSS, Radix UI Toast, and `socket.io-client`.

## Deterministic Dependency Installation

### Backend (`backend/`)
`backend/requirements.txt` is a hash-locked file compiled from `backend/requirements.in` for Python 3.11. Always install with `--require-hashes`:
```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install --no-cache-dir --require-hashes -r requirements.txt
```

To verify the container image build (`FROM python:3.11-slim`):
```bash
docker build -t coffee-backend ./backend
```

### Frontend (`frontend/`)
`frontend/package-lock.json` is tracked in git. Always install the locked dependency tree with `npm ci`:
```bash
cd frontend
npm ci
```

## Refreshing Lockfiles Locally

### Backend (`backend/requirements.in` -> `backend/requirements.txt`)
Never hand-edit `backend/requirements.txt` or add unhashed packages. Update version constraints in `backend/requirements.in` and recompile against Python 3.11 so wheel and sdist SHA-256 hashes match `python:3.11-slim`:
```bash
docker run --rm -v "$PWD/backend:/work" -w /work python:3.11-slim sh -c \
  "pip install --no-cache-dir pip-tools && pip-compile --generate-hashes --strip-extras --output-file=requirements.txt requirements.in"
```
Alternatively, from an activated Python 3.11 virtual environment with `pip-tools` installed:
```bash
cd backend
pip-compile --generate-hashes --strip-extras --output-file=requirements.txt requirements.in
```

Key compatibility constraints maintained in `backend/requirements.in`:
- `sqlalchemy>=2.0.0,<2.1.0` so `postgresql://` URLs route to `psycopg2-binary`.
- `passlib[bcrypt]==1.7.4` and `bcrypt>=4.0.1,<4.1.0` for compatible password hashing in `app/auth.py` and `seed.py`.
- `pydantic>=1.10.13,<2.0.0` and `fastapi>=0.100.0,<0.113.0` for Pydantic v1 `orm_mode` and `.dict()` compatibility.
- `python-socketio>=5.11.0,<6.0.0` (do not use the non-existent `python-socketio[asgi]` extra).

### Frontend (`frontend/package.json` -> `frontend/package-lock.json`)
Keep `package-lock.json` tracked in git (do not ignore lockfiles in `.gitignore`). After updating `frontend/package.json`, regenerate `frontend/package-lock.json` and verify `npm ci`:
```bash
cd frontend
npm install --package-lock-only
npm ci
npm run build
```

## Local Run & Verification Commands

### Backend
```bash
cd backend
# Ensure JWT_SECRET (min 8 non-default chars) and optional DATABASE_URL are set
export JWT_SECRET="local-dev-strong-secret-key"
python seed.py
uvicorn app.main:app --reload
```

### Frontend
```bash
cd frontend
npm ci
npm run build
npm run test:unit
npm run dev
```
