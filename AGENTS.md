# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions, secret management and deployment guardrails, and exact local verification commands that mirror `.github/workflows/ci.yml` and `backend/cloudbuild.yaml`.

## Repository Structure

- `backend/` — FastAPI, SQLAlchemy, JWT (`python-jose` + `passlib`), and Socket.IO backend (`app/main.py`, `seed.py`, `tests/`, `Dockerfile`, `cloudbuild.yaml`, `.env.example`).
- `frontend/` — Next.js 14 (Pages Router, TypeScript, Tailwind CSS) frontend (`package.json`, `tsconfig.json`, `next.config.js`).
- `.github/workflows/ci.yml` — Parallel `backend-checks` and `frontend-build` GitHub Actions jobs triggered on pushes and pull requests to `main`.

## Secret Management & Deployment Guardrails

- **No Plaintext Secrets in Build Configs**: `backend/cloudbuild.yaml` and `bootstrap_coffee_shop.sh` must never define plaintext password or signing-key substitutions (such as `_DB_PASS` or `_JWT_SECRET`) or `'replace-me'` defaults.
- **Cloud Run Secret Manager Bindings**: `DATABASE_URL` and `JWT_SECRET` are bound at runtime on Cloud Run via `--set-secrets=DATABASE_URL=${_DB_URL_SECRET}:latest,JWT_SECRET=${_JWT_SECRET_NAME}:latest`. Do not inject secret payloads into Cloud Build `availableSecrets` or `secretEnv`.
- **Dedicated Least-Privilege Identities**: Cloud Build executes under `projects/$PROJECT_ID/serviceAccounts/${_BUILD_SERVICE_ACCOUNT}` with `options.logging: CLOUD_LOGGING_ONLY`, and Cloud Run executes under `--service-account=${_RUN_SERVICE_ACCOUNT}`.
- **Custom Delimiter for Non-Secret Env Vars**: `gcloud run deploy` passes non-secret environment variables using `--set-env-vars=^|^INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE}|APP_ENV=production` so colons in Cloud SQL connection names never collide with `gcloud` argument delimiters.
- **Production Startup Guards**: When `APP_ENV=production` or `K_SERVICE` is set, `app.auth` and `app.database` reject placeholder values (`replace-me`, `dev_secret_key`, `YOUR_PROJECT_ID`, `YOUR_DB_PASSWORD`, `local-dev-secret-not-for-production`), unconfigured `DATABASE_URL` / `INSTANCE_UNIX_SOCKET` values, and any `JWT_SECRET` shorter than 32 characters with `RuntimeError`.
- **CI Workflow Guardrails**:
  - Do not add workflow path filters to `.github/workflows/ci.yml` that could skip required branch-protection checks.
  - Keep CI token permissions read-only (`contents: read`) unless a job explicitly publishes artifacts.
  - Remove untracked local artifacts (`backend/dev.db`, `frontend/tsconfig.tsbuildinfo`) before committing.

## Environment Variables & Local Setup

- `JWT_SECRET`: **Required** whenever `app.auth` or `app.main` is imported. Locally, it must be at least 8 characters and must not match insecure placeholders (`dev_secret_key`, `secret`, `password`, `changeme`, `replace-me`, `replace-with-strong-random`). In production (`APP_ENV=production` or `K_SERVICE` set), it must be at least 32 characters and bound from Secret Manager.
- `DATABASE_URL`: Optional for local runs and smoke checks. When unset or blank locally, `backend/app/database.py` defaults to `sqlite:///./dev.db` with `check_same_thread=False`. Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coffee_test` to target PostgreSQL locally; in production it is required and bound from Secret Manager.

Copy the tracked template `backend/.env.example` to `backend/.env` (which remains ignored by Git) for local development:

```bash
cp backend/.env.example backend/.env
```

## Local Verification Commands (CI & Cloud Build Parity)

Run these checks from the repository root (`coffee-shop-app/`) before opening or updating a pull request.

### 1. Backend Setup & `.gitignore` Verification

```bash
# Must exit non-zero (not ignored) and show backend/.env.example is tracked:
! git check-ignore -q backend/.env.example
git ls-files --error-unmatch backend/.env.example

# Confirm real .env files remain ignored by Git:
git check-ignore -q backend/.env

cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt pytest httpx websockets
```

### 2. Backend Smoke Checks (SQLite Default & PostgreSQL)

Verifies `app.main` startup imports and `seed.py` execution without `DATABASE_URL` (matching `backend-checks` in `.github/workflows/ci.yml`):

```bash
cd backend
unset DATABASE_URL
rm -f dev.db
JWT_SECRET="local-dev-jwt-secret-key-12345" python -c "import app.main"
JWT_SECRET="local-dev-jwt-secret-key-12345" python seed.py
rm -f dev.db
```

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

### 3. Validate `backend/cloudbuild.yaml` & Production Startup Guards

```bash
python3 -c '
import yaml
from pathlib import Path

text = Path("backend/cloudbuild.yaml").read_text()
assert "replace-me" not in text
cfg = yaml.safe_load(text)
subs = cfg.get("substitutions", {})
assert "_DB_PASS" not in subs and "_JWT_SECRET" not in subs
assert cfg.get("serviceAccount") == "projects/$PROJECT_ID/serviceAccounts/${_BUILD_SERVICE_ACCOUNT}"
assert cfg.get("options", {}).get("logging") == "CLOUD_LOGGING_ONLY"
for step in cfg["steps"]:
    assert "availableSecrets" not in cfg and "secretEnv" not in step
deploy_args = " ".join(cfg["steps"][-1]["args"])
assert "--service-account=${_RUN_SERVICE_ACCOUNT}" in deploy_args
assert "--set-env-vars=^|^INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE}|APP_ENV=production" in deploy_args
assert "--set-secrets=DATABASE_URL=${_DB_URL_SECRET}:latest,JWT_SECRET=${_JWT_SECRET_NAME}:latest" in deploy_args
print("cloudbuild.yaml structure verified.")
'

cd backend
python3 -c '
import os, subprocess, sys

for mod in ("app.auth", "app.database"):
    env = {**os.environ, "K_SERVICE": "coffee-backend", "JWT_SECRET": "replace-me"}
    res = subprocess.run([sys.executable, "-c", f"import {mod}"], env=env, capture_output=True, text=True)
    assert res.returncode != 0 and ("RuntimeError" in res.stderr or "ConfigurationError" in res.stderr), res.stderr
print("Production startup guards verified.")
'
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
    pip install --no-cache-dir pytest httpx websockets pyyaml
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
