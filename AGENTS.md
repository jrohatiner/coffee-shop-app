# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions, deterministic dependency management, and exact local verification commands that mirror `.github/workflows/ci.yml` and `backend/cloudbuild.yaml`.

## Repository Structure

- `backend/` — FastAPI, SQLAlchemy 2.0.x, JWT (`python-jose` + `passlib`/bcrypt), and Socket.IO backend running on Python 3.11 (`app/main.py`, `seed.py`, `tests/`, `requirements.in`, `requirements.txt`, `Dockerfile`, `cloudbuild.yaml`).
- `frontend/` — Next.js `14.1.0` (Pages Router, TypeScript, Tailwind CSS, Radix UI Toast, `socket.io-client`) frontend (`package.json`, `package-lock.json`, `tsconfig.json`, `next.config.js`).
- `.github/workflows/ci.yml` — Parallel `backend-checks` and `frontend-build` GitHub Actions jobs triggered on pushes and pull requests to `main`.

## Required Environment Variables

- `JWT_SECRET`: **Required** whenever `app.auth` or `app.main` is imported. Must be at least 8 characters and must not match insecure placeholders (`dev_secret_key`, `secret`, `password`, `changeme`, `replace-me`, `replace-with-strong-random`).
- `DATABASE_URL`: Optional for local runs and smoke checks. When unset or blank, `backend/app/database.py` defaults to `sqlite:///./dev.db` with `check_same_thread=False`. Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coffee_test` to target PostgreSQL.

## Deterministic Dependency Installation & Lockfile Maintenance

### Backend (`backend/requirements.in` -> `backend/requirements.txt`)

`backend/requirements.txt` is a hash-locked file compiled from `backend/requirements.in` for Python 3.11 (`python:3.11-slim` in `backend/Dockerfile`). Never hand-edit `backend/requirements.txt` or mix unhashed packages into a `--require-hashes` install command.

To update backend dependencies, edit `backend/requirements.in` and recompile against Python 3.11 so wheel and sdist SHA-256 hashes match `python:3.11-slim`:

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
- `pydantic>=2.7.0,<3.0.0` and `fastapi>=0.115.0,<1.0.0` for Pydantic v2 (`TypeAdapter`, `model_validate`, and `orm_mode`/`from_attributes`) and Starlette CORS compatibility.
- `python-socketio>=5.11.0,<6.0.0` (do not use the non-existent `python-socketio[asgi]` extra).

### Frontend (`frontend/package.json` -> `frontend/package-lock.json`)

`frontend/package-lock.json` is tracked in git (do not ignore lockfiles in `.gitignore`). Always install the locked dependency tree with `npm ci`. After updating `frontend/package.json`, regenerate `frontend/package-lock.json` and verify a clean build:

```bash
cd frontend
npm install --package-lock-only
npm ci
npm run build
```

## Local Verification Commands (CI Parity)

Run all commands below from the repository root (`coffee-shop-app/`) before opening or updating a pull request.

### 1. Backend Setup

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install --no-cache-dir --require-hashes -r requirements.txt
pip install pytest httpx websockets
```

### 2. Backend Smoke Checks (SQLite Default)

Verifies `app.main` startup imports and `seed.py` execution without `DATABASE_URL` (matching `backend-checks` in `.github/workflows/ci.yml`):

```bash
cd backend
unset DATABASE_URL
rm -f dev.db
JWT_SECRET="local-dev-jwt-secret-key-12345" python -c "import app.main"
JWT_SECRET="local-dev-jwt-secret-key-12345" python seed.py
rm -f dev.db
```

### 3. Backend Smoke Checks (PostgreSQL — When Available)

When a local or containerized PostgreSQL instance is running on `localhost:5432`:

```bash
cd backend
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/coffee_test" \
  JWT_SECRET="local-dev-jwt-secret-key-12345" \
  python -c "import app.main"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/coffee_test" \
  JWT_SECRET="local-dev-jwt-secret-key-12345" \
  python seed.py
```

### 4. Backend `pytest` Suite

Runs all unit and integration tests strictly under `backend/tests/`:

```bash
cd backend
JWT_SECRET="local-dev-jwt-secret-key-12345" PYTHONPATH=. python -m pytest -v
```

### 5. Backend Container Gate (Cloud Build Parity)

Reproduces the `build-image` and `test-image` steps in `backend/cloudbuild.yaml`:

```bash
cd backend
docker build -t coffee-backend:local .
docker run --rm -e JWT_SECRET="cloudbuild-test-jwt-secret-key" coffee-backend:local sh -ceu '
  unset DATABASE_URL
  python -c "import app.main"
  python seed.py
  rm -f dev.db
  if [ -d tests ] && ls tests/test_*.py >/dev/null 2>&1; then
    pip install --no-cache-dir pytest httpx websockets
    PYTHONPATH=. python -m pytest -v
  fi
'
```

### 6. Frontend Build, TypeScript & Unit Test Verification

```bash
cd frontend
npm ci --no-audit --no-fund
NEXT_TELEMETRY_DISABLED=1 npm run build
npm run test:unit
```

## Guardrails

- Do not ignore `frontend/package-lock.json` in `.gitignore` or hand-edit `backend/requirements.txt` without SHA-256 hashes.
- Do not add workflow path filters to `.github/workflows/ci.yml` that could skip required branch-protection checks.
- Keep CI token permissions read-only (`contents: read`) unless a job explicitly publishes artifacts.
- Remove untracked local artifacts (`backend/dev.db`, `frontend/tsconfig.tsbuildinfo`) before committing.
