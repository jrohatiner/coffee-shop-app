# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions and exact local verification commands that mirror `.github/workflows/ci.yml` and `backend/cloudbuild.yaml`.

## Repository Structure

- `backend/` — FastAPI, SQLAlchemy, JWT (`python-jose` + `passlib`), and Socket.IO backend (`app/main.py`, `seed.py`, `tests/`, `Dockerfile`, `cloudbuild.yaml`).
- `frontend/` — Next.js 14 (Pages Router, TypeScript, Tailwind CSS) frontend (`package.json`, `tsconfig.json`, `next.config.js`).
- `.github/workflows/ci.yml` — Parallel `backend-checks` and `frontend-build` GitHub Actions jobs triggered on pushes and pull requests to `main`.

## Required Environment Variables

- `JWT_SECRET`: **Required** whenever `app.auth` or `app.main` is imported. Must be at least 8 characters and must not match insecure placeholders (`dev_secret_key`, `secret`, `password`, `changeme`, `replace-me`, `replace-with-strong-random`).
- `DATABASE_URL`: Optional for local runs and smoke checks. When unset or blank, `backend/app/database.py` defaults to `sqlite:///./dev.db` with `check_same_thread=False`. Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coffee_test` to target PostgreSQL.

## Local Verification Commands (CI Parity)

Run all commands below from the repository root (`coffee-shop-app/`) before opening or updating a pull request.

### 1. Backend Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt pytest httpx websockets
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

### 6. Frontend Build & TypeScript Verification

Note that `.gitignore` excludes `package-lock.json`; pass `--no-package-lock` when installing dependencies locally so git working trees stay clean:

```bash
cd frontend
npm install --no-package-lock --legacy-peer-deps --no-audit --no-fund
NEXT_TELEMETRY_DISABLED=1 npm run build
```

## Guardrails

- Do not add workflow path filters to `.github/workflows/ci.yml` that could skip required branch-protection checks.
- Keep CI token permissions read-only (`contents: read`) unless a job explicitly publishes artifacts.
- Remove untracked local artifacts (`backend/dev.db`, `frontend/tsconfig.tsbuildinfo`) before committing.
