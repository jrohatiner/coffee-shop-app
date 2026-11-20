# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions, pre-commit and static analysis checks, container release/SLSA provenance guardrails, secret management and deployment guardrails, and exact local verification commands that mirror `.github/workflows/ci.yml` and `backend/cloudbuild.yaml`.

## Repository Structure

- `backend/` — FastAPI, SQLAlchemy, JWT (`python-jose` + `passlib`), and Socket.IO backend (`app/main.py`, `seed.py`, `tests/`, `Dockerfile`, `.dockerignore`, `cloudbuild.yaml`, `.env.example`, `pyproject.toml`).
- `frontend/` — Next.js 14 (Pages Router, TypeScript, Tailwind CSS) frontend (`package.json`, `tsconfig.json`, `next.config.js`).
- `.github/workflows/ci.yml` — Parallel `backend-checks` and `frontend-build` GitHub Actions jobs triggered on pushes and pull requests to `main`.
- `.pre-commit-config.yaml` — Pre-commit hooks enforcing Ruff, Mypy, Prettier, YAML syntax, and whitespace rules.

## Secret Management, Release & Provenance Guardrails

- **No Plaintext Secrets in Build Configs**: `backend/cloudbuild.yaml` and `bootstrap_coffee_shop.sh` must never define plaintext password or signing-key substitutions (such as `_DB_PASS` or `_JWT_SECRET`) or `'replace-me'` defaults.
- **Cloud Run Secret Manager Bindings**: `DATABASE_URL` and `JWT_SECRET` are bound at runtime on Cloud Run via `--set-secrets=DATABASE_URL=${_DB_URL_SECRET}:latest,JWT_SECRET=${_JWT_SECRET_NAME}:latest`. Do not inject secret payloads into Cloud Build `availableSecrets` or `secretEnv`.
- **Dedicated Least-Privilege Identities**: Cloud Build executes under `projects/$PROJECT_ID/serviceAccounts/${_BUILD_SERVICE_ACCOUNT}` with `options.logging: CLOUD_LOGGING_ONLY`, and Cloud Run executes under `--service-account=${_RUN_SERVICE_ACCOUNT}`.
- **Custom Delimiter for Non-Secret Env Vars**: `gcloud run deploy` passes non-secret environment variables using `--set-env-vars=^|^INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE}|APP_ENV=production` so colons in Cloud SQL connection names never collide with `gcloud` argument delimiters.
- **Production Startup Guards**: When `APP_ENV=production` or `K_SERVICE` is set, `app.auth` and `app.database` reject placeholder values (`replace-me`, `dev_secret_key`, `YOUR_PROJECT_ID`, `YOUR_DB_PASSWORD`, `local-dev-secret-not-for-production`), unconfigured `DATABASE_URL` / `INSTANCE_UNIX_SOCKET` values, and any `JWT_SECRET` shorter than 32 characters with `RuntimeError`.
- **No Mutable `:latest` Image Tags & `@sha256:` Digest Deployment**: Every build in `backend/cloudbuild.yaml` tags the image with `$BUILD_ID` (and `$COMMIT_SHA` when present), resolves the pushed `@sha256:` digest into `/workspace/image-digest.txt`, and deploys that immutable `@sha256:` digest to Cloud Run (keeping `$BUILD_ID` unconditional so manual `gcloud builds submit` works when `$COMMIT_SHA` is empty).
- **SLSA Build Provenance & Filtered Build Context**: `backend/cloudbuild.yaml` registers `${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID` in top-level `images` with `options.requestedVerifyOption: VERIFIED` (note that full SLSA Level 3 source provenance requires trigger-driven builds from connected repositories). `backend/Dockerfile` pins `python:3.11-slim` by `@sha256:` digest, and `backend/.dockerignore` excludes `cloudbuild.yaml`, `Dockerfile`, `seed.py`, `tests/`, `.env*`, `.venv/`, `__pycache__/`, and `*.db` from the pushed image.
- **CI Workflow Guardrails**:
  - Do not add workflow path filters to `.github/workflows/ci.yml` that could skip required branch-protection checks.
  - Keep CI token permissions read-only (`contents: read`) unless a job explicitly publishes artifacts.
  - Remove untracked local artifacts (`backend/dev.db`, `frontend/tsconfig.tsbuildinfo`) before committing.

## Pre-commit and Static Analysis Guardrails

Install Git pre-commit hooks locally so every commit enforces formatting, linting, type checking, YAML syntax, and whitespace rules:

```bash
pre-commit install
pre-commit run --all-files
```

### Python Lint, Format, and Type Checking (`backend/`)

```bash
ruff check --config backend/pyproject.toml backend
ruff format --check --config backend/pyproject.toml backend
mypy --config-file backend/pyproject.toml backend
```

### Markdown Formatting (Prettier)

```bash
prettier --check "**/*.md"
prettier --write "**/*.md"
```

### Frontend Static Analysis, Formatting, Build, and Tests (`frontend/`)

- Keep `"strict": true`, `"skipLibCheck": false`, `"noUnusedLocals": true`, and `"noUnusedParameters": true` enabled in `frontend/tsconfig.json`.
- Avoid explicit `any` annotations; share API payload interfaces via `frontend/types/api.ts` (matching `backend/app/schemas.py`) and narrow `unknown` errors with `axios.isAxiosError`.

```bash
cd frontend
npm install --no-package-lock --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm run lint
npm run format:check
NEXT_TELEMETRY_DISABLED=1 npm run build
npm run test:unit
npm run test:e2e
```

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
! git check-ignore -q backend/.env.example
git ls-files --error-unmatch backend/.env.example
git check-ignore -q backend/.env

cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt pytest httpx websockets
```

### 2. Backend Smoke Checks (SQLite Default & PostgreSQL)

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

### 3. Validate `backend/cloudbuild.yaml`, Provenance & Production Startup Guards

```bash
python3 -c '
import re, yaml
from pathlib import Path

text = Path("backend/cloudbuild.yaml").read_text()
assert "replace-me" not in text
assert not re.search(r"coffee-repo/coffee-backend(?![:@])|coffee-repo/coffee-backend:latest\b", text)
cfg = yaml.safe_load(text)
subs = cfg.get("substitutions", {})
assert "_DB_PASS" not in subs and "_JWT_SECRET" not in subs
assert cfg.get("serviceAccount") == "projects/$PROJECT_ID/serviceAccounts/${_BUILD_SERVICE_ACCOUNT}"
assert cfg.get("options", {}).get("logging") == "CLOUD_LOGGING_ONLY"
assert cfg.get("options", {}).get("requestedVerifyOption") == "VERIFIED"
assert "${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID" in cfg.get("images", [])
assert [s["id"] for s in cfg["steps"]] == ["validate-substitutions", "build-image", "test-image", "push-image", "deploy-cloud-run"]
for step in cfg["steps"]:
    assert "availableSecrets" not in cfg and "secretEnv" not in step
deploy_args = " ".join(cfg["steps"][-1]["args"])
assert "--service-account=${_RUN_SERVICE_ACCOUNT}" in deploy_args
assert "--set-env-vars=^|^INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE}|APP_ENV=production" in deploy_args
assert "--set-secrets=DATABASE_URL=${_DB_URL_SECRET}:latest,JWT_SECRET=${_JWT_SECRET_NAME}:latest" in deploy_args
print("cloudbuild.yaml structure and provenance verified.")
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

```bash
cd backend
JWT_SECRET="local-dev-jwt-secret-key-12345" PYTHONPATH=. python -m pytest -v
```

### 5. Backend Container & Cloud Build Pipeline Gate

```bash
docker build -t coffee-backend:local backend
docker run --rm --entrypoint find coffee-backend:local /app -mindepth 1 -maxdepth 3 | sort

cd backend
tar -cf - seed.py cloudbuild.yaml .env.example tests | docker run --rm -i \
  -e JWT_SECRET="cloudbuild-test-jwt-secret-key" \
  coffee-backend:local \
  sh -ceu '
    tar -xf - -C /app
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
