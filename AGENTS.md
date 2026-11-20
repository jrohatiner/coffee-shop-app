# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions, pre-commit guardrails, secret management and Cloud Run deployment guardrails, container release/SLSA provenance guardrails, architecture details, and exact local verification commands that mirror `.github/workflows/ci.yml`, `.github/workflows/deploy-frontend.yml`, `backend/cloudbuild.yaml`, and `frontend/cloudbuild.yaml`.

## Repository Structure & Architecture

- `backend/` — FastAPI, SQLAlchemy, JWT (`python-jose` + `passlib`), and `python-socketio` ASGI backend (`app/main.py`, `seed.py`, `tests/`, `Dockerfile`, `.dockerignore`, `cloudbuild.yaml`, `.env.example`, `pyproject.toml`) deployed to Cloud Run as `coffee-backend` in `us-central1`.
  - REST routers in `backend/app/main.py`: `/auth`, `/dashboard`, `/orders`, `/inventory`, `/reports`, `/users`.
  - Socket.IO ASGI endpoint in `backend/app/websockets.py`: mounted at `/ws` with `socketio_path='/ws/socket.io'`.
- `frontend/` — Next.js `14.1.0` (Pages Router, TypeScript, Tailwind CSS) frontend (`package.json`, `tsconfig.json`, `next.config.js`, `firebase.json`, `cloudbuild.yaml`) configured for static HTML export (`output: 'export'`, `images: { unoptimized: true }`) into `frontend/out` and deployed to Firebase Hosting (`cleanUrls: true`).
- `.github/workflows/ci.yml` — Parallel `backend-checks` and `frontend-build` GitHub Actions jobs triggered on pushes and pull requests to `main`.
- `.github/workflows/deploy-frontend.yml` — Frontend static export verification (`verify`) and Workload Identity Federation deployment with SHA-256 manifest provenance attestation (`deploy`).
- `.pre-commit-config.yaml` — Pre-commit hooks enforcing Ruff, Mypy, Prettier, YAML syntax, and whitespace rules.

## Environment Variables & Local Setup

### Backend

- `JWT_SECRET`: **Required** whenever `app.auth` or `app.main` is imported. Locally, it must be at least 8 characters and must not match insecure placeholders (`dev_secret_key`, `secret`, `password`, `changeme`, `replace-me`, `replace-with-strong-random`). In production (`APP_ENV=production` or `K_SERVICE` set), it must be at least 32 characters and bound from Secret Manager.
- `DATABASE_URL`: Optional for local runs and smoke checks. When unset or blank locally, `backend/app/database.py` defaults to `sqlite:///./dev.db` with `check_same_thread=False`. Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coffee_test` to target PostgreSQL locally; in production it is required and bound from Secret Manager.

Copy the tracked template `backend/.env.example` to `backend/.env` (which remains ignored by Git) for local development:

```bash
cp backend/.env.example backend/.env
```

### Frontend

- `NEXT_PUBLIC_API_URL`: Base URL for Axios REST calls (`frontend/lib/api.ts`). Required for release builds; never falls back to `http://localhost:8000` in production (`NODE_ENV=production`).
- `NEXT_PUBLIC_SOCKET_URL`: Optional direct origin for Socket.IO (`frontend/hooks/useSocket.ts`) to connect directly to Cloud Run (`coffee-backend`) when CDN rewrites strip WebSocket `Upgrade` headers. Falls back to `NEXT_PUBLIC_API_URL` (or same-origin `/ws/socket.io` when relative/unset in production).
- `FIREBASE_PROJECT_ID`: Explicit target Firebase project passed via `--project "$FIREBASE_PROJECT_ID"` (`frontend/.firebaserc` intentionally omits hardcoded project aliases).

## Secret Management, Release & Provenance Guardrails

- **No Plaintext Secrets in Build Configs**: `backend/cloudbuild.yaml` and `bootstrap_coffee_shop.sh` must never define plaintext password or signing-key substitutions (such as `_DB_PASS` or `_JWT_SECRET`) or `'replace-me'` defaults.
- **Cloud Run Secret Manager Bindings**: `DATABASE_URL` and `JWT_SECRET` are bound at runtime on Cloud Run via `--set-secrets=DATABASE_URL=${_DB_URL_SECRET}:latest,JWT_SECRET=${_JWT_SECRET_NAME}:latest`. Do not inject secret payloads into Cloud Build `availableSecrets` or `secretEnv`.
- **Dedicated Least-Privilege Identities**: Cloud Build executes under `projects/$PROJECT_ID/serviceAccounts/${_BUILD_SERVICE_ACCOUNT}` with `options.logging: CLOUD_LOGGING_ONLY`, and Cloud Run executes under `--service-account=${_RUN_SERVICE_ACCOUNT}`.
- **Custom Delimiter for Non-Secret Env Vars**: `gcloud run deploy` passes non-secret environment variables using `--set-env-vars=^|^INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE}|APP_ENV=production` so colons in Cloud SQL connection names never collide with `gcloud` argument delimiters.
- **Production Startup Guards**: When `APP_ENV=production` or `K_SERVICE` is set, `app.auth` and `app.database` reject placeholder values (`replace-me`, `dev_secret_key`, `YOUR_PROJECT_ID`, `YOUR_DB_PASSWORD`, `local-dev-secret-not-for-production`), unconfigured `DATABASE_URL` / `INSTANCE_UNIX_SOCKET` values, and any `JWT_SECRET` shorter than 32 characters with `RuntimeError`.
- **No Mutable `:latest` Image Tags & `@sha256:` Digest Deployment**: Every build in `backend/cloudbuild.yaml` tags the image with `$BUILD_ID` (and `$COMMIT_SHA` whenever Git metadata is present), resolves the pushed `@sha256:` digest from Artifact Registry (`RepoDigests`) into `/workspace/image-digest.txt`, and deploys that immutable `@sha256:` digest to Cloud Run (keeping `$BUILD_ID` unconditional so manual `gcloud builds submit` works when `$COMMIT_SHA` is empty).
- **SLSA Build Provenance & Filtered Build Context**: `backend/cloudbuild.yaml` registers `${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID` in top-level `images` with `options.requestedVerifyOption: VERIFIED` (note that full SLSA Level 3 source provenance requires trigger-driven builds from connected repositories). `backend/Dockerfile` pins `python:3.11-slim` by `@sha256:` digest, and `backend/.dockerignore` excludes `cloudbuild.yaml`, `Dockerfile`, `seed.py`, `app/routers/_init_.py`, `tests/`, `.env*`, `.venv/`, `__pycache__/`, and `*.db` from the production container image.

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

## Local Verification Commands (CI & Cloud Build Parity)

Run all commands below from the repository root (`coffee-shop-app/`) before opening or updating a pull request.

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

### 6. Frontend Setup, Typecheck, Lint, Format, and Tests (`frontend/`)

Note that `.gitignore` excludes `package-lock.json`; pass `--no-package-lock` when installing dependencies locally so git working trees stay clean:

```bash
cd frontend
npm install --no-package-lock --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
node --test __tests__/orderState.test.mjs
npm run test:e2e
NEXT_TELEMETRY_DISABLED=1 npm run build
```

### 7. Static Next.js Build, Export, and Bundle Audit

Build the static export into `frontend/out` with production API/Socket URLs and verify that all eight static HTML pages exist with zero `http://localhost:8000` references:

```bash
cd frontend
NEXT_PUBLIC_API_URL="https://coffee-backend-example.us-central1.run.app" \
NEXT_PUBLIC_SOCKET_URL="https://coffee-backend-example.us-central1.run.app" \
npm run build

NEXT_PUBLIC_API_URL="https://coffee-backend-example.us-central1.run.app" npm run export

for page in index.html login.html dashboard.html orders.html inventory.html reports.html users.html 404.html; do
  test -f "out/$page"
done
test "$(find out -maxdepth 1 -name '*.html' | wc -l | tr -d ' ')" -eq 8
! grep -rnF 'http://localhost:8000' out/

cd out
find . -type f ! -name 'manifest.sha256' -print0 \
  | LC_ALL=C sort -z \
  | xargs -0 sha256sum > manifest.sha256
sha256sum -c manifest.sha256
```

### 8. Firebase Hosting & CI Workflow Validation

```bash
cd frontend
node -e '
  const fs = require("node:fs");
  const assert = require("node:assert/strict");

  const firebaseConfig = JSON.parse(fs.readFileSync("firebase.json", "utf8"));
  assert.equal(firebaseConfig.hosting?.public, "out");
  assert.equal(firebaseConfig.hosting?.cleanUrls, true);

  const rewrites = firebaseConfig.hosting?.rewrites ?? [];
  for (const source of [
    "/api/**",
    "/auth/**",
    "/dashboard/**",
    "/orders/**",
    "/inventory/**",
    "/reports/**",
    "/users/**",
    "/ws/**",
  ]) {
    const rule = rewrites.find((entry) => entry.source === source);
    assert.ok(rule, `Missing rewrite for ${source}`);
    assert.equal(rule.run?.serviceId, "coffee-backend");
    assert.equal(rule.run?.region, "us-central1");
  }

  const firebasercRaw = fs.readFileSync(".firebaserc", "utf8");
  assert.ok(!firebasercRaw.includes("YOUR_FIREBASE_PROJECT_ID"));
  JSON.parse(firebasercRaw);
  console.log("Firebase Hosting configuration valid.");
'

cd ..
check-jsonschema --builtin-schema vendor.github-workflows .github/workflows/ci.yml .github/workflows/deploy-frontend.yml
check-jsonschema --builtin-schema vendor.cloudbuild backend/cloudbuild.yaml frontend/cloudbuild.yaml
```

## Guardrails

- Keep `"strict": true`, `"skipLibCheck": false`, `"noUnusedLocals": true`, and `"noUnusedParameters": true` enabled in `frontend/tsconfig.json`.
- Avoid explicit `any` annotations; share API payload interfaces via `frontend/types/api.ts` (matching `backend/app/schemas.py`) and narrow `unknown` errors with `axios.isAxiosError`.
- Do not add workflow path filters to `.github/workflows/ci.yml` that could skip required branch-protection checks.
- Keep CI token permissions read-only (`contents: read`) unless a job explicitly publishes artifacts or attestations.
- Never allow `http://localhost:8000` fallbacks in production frontend builds (`frontend/out`).
- Remove untracked local artifacts (`backend/dev.db`, `frontend/tsconfig.tsbuildinfo`, `frontend/package-lock.json`) before committing.
