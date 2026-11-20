# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions, pre-commit guardrails, architecture details, and exact local verification commands that mirror `.github/workflows/ci.yml`, `.github/workflows/deploy-frontend.yml`, `backend/cloudbuild.yaml`, and `frontend/cloudbuild.yaml`.

## Repository Structure & Architecture

- `backend/` — FastAPI, SQLAlchemy, JWT (`python-jose` + `passlib`), and `python-socketio` ASGI backend (`app/main.py`, `seed.py`, `tests/`, `Dockerfile`, `cloudbuild.yaml`, `pyproject.toml`) deployed to Cloud Run as `coffee-backend` in `us-central1`.
  - REST routers in `backend/app/main.py`: `/auth`, `/dashboard`, `/orders`, `/inventory`, `/reports`, `/users`.
  - Socket.IO ASGI endpoint in `backend/app/websockets.py`: mounted at `/ws` with `socketio_path='/ws/socket.io'`.
- `frontend/` — Next.js `14.1.0` (Pages Router, TypeScript, Tailwind CSS) frontend (`package.json`, `tsconfig.json`, `next.config.js`, `firebase.json`, `cloudbuild.yaml`) configured for static HTML export (`output: 'export'`, `images: { unoptimized: true }`) into `frontend/out` and deployed to Firebase Hosting (`cleanUrls: true`).
- `.github/workflows/ci.yml` — Parallel `backend-checks` and `frontend-build` GitHub Actions jobs triggered on pushes and pull requests to `main`.
- `.github/workflows/deploy-frontend.yml` — Frontend static export verification (`verify`) and Workload Identity Federation deployment with SHA-256 manifest provenance attestation (`deploy`).

## Environment Variables

### Backend

- `JWT_SECRET`: **Required** whenever `app.auth` or `app.main` is imported. Must be at least 8 characters and must not match insecure placeholders (`dev_secret_key`, `secret`, `password`, `changeme`, `replace-me`, `replace-with-strong-random`).
- `DATABASE_URL`: Optional for local runs and smoke checks. When unset or blank, `backend/app/database.py` defaults to `sqlite:///./dev.db` with `check_same_thread=False`. Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coffee_test` to target PostgreSQL.

### Frontend

- `NEXT_PUBLIC_API_URL`: Base URL for Axios REST calls (`frontend/lib/api.ts`). Required for release builds; never falls back to `http://localhost:8000` in production (`NODE_ENV=production`).
- `NEXT_PUBLIC_SOCKET_URL`: Optional direct origin for Socket.IO (`frontend/hooks/useSocket.ts`) to connect directly to Cloud Run (`coffee-backend`) when CDN rewrites strip WebSocket `Upgrade` headers. Falls back to `NEXT_PUBLIC_API_URL` (or same-origin `/ws/socket.io` when relative/unset in production).
- `FIREBASE_PROJECT_ID`: Explicit target Firebase project passed via `--project "$FIREBASE_PROJECT_ID"` (`frontend/.firebaserc` intentionally omits hardcoded project aliases).

## Pre-commit and Local Guardrails

Install Git pre-commit hooks locally so every commit enforces formatting, linting, type checking, YAML syntax, and whitespace rules:

```bash
pre-commit install
```

Run the full pre-commit suite across all tracked files:

```bash
pre-commit run --all-files
```

### Python Lint and Format (Ruff)

Run Ruff lint and format checks targeting `backend/` (configured via `backend/pyproject.toml` for Python 3.11):

```bash
ruff check --config backend/pyproject.toml backend
ruff format --check --config backend/pyproject.toml backend
```

Apply automatic lint fixes and formatting:

```bash
ruff check --fix --config backend/pyproject.toml backend
ruff format --config backend/pyproject.toml backend
```

### Python Static Type Checking (Mypy)

Run strict Mypy type checks against `backend/`:

```bash
mypy --config-file backend/pyproject.toml backend
```

### Markdown Formatting (Prettier)

Check or format Markdown files with Prettier (scoped to `*.md` files):

```bash
prettier --check "**/*.md"
prettier --write "**/*.md"
```

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

### 6. Frontend Setup, Typecheck, Lint, Format, and Tests (`frontend/`)

Note that `.gitignore` excludes `package-lock.json`; pass `--no-package-lock` when installing dependencies locally so git working trees stay clean:

```bash
cd frontend
npm install --no-package-lock --legacy-peer-deps --no-audit --no-fund

# Strict TypeScript typechecking (tsc --noEmit)
npm run typecheck

# Non-interactive Next.js ESLint check (next lint --max-warnings 0)
npm run lint

# Prettier formatting check (prettier --check .)
npm run format:check

# Auto-format frontend files with Prettier (prettier --write .)
npm run format

# Unit and E2E tests
npm run test:unit
node --test __tests__/orderState.test.mjs
npm run test:e2e

# Production Next.js build (matches CI frontend-build)
NEXT_TELEMETRY_DISABLED=1 npm run build
```

### 7. Static Next.js Build, Export, and Bundle Audit

Build the static export into `frontend/out` with production API/Socket URLs:

```bash
cd frontend
NEXT_PUBLIC_API_URL="https://coffee-backend-example.us-central1.run.app" \
NEXT_PUBLIC_SOCKET_URL="https://coffee-backend-example.us-central1.run.app" \
npm run build
```

Verify the `export` script alias (`next build`) also succeeds cleanly on Next.js `14.1.0`:

```bash
cd frontend
NEXT_PUBLIC_API_URL="https://coffee-backend-example.us-central1.run.app" npm run export
```

Verify that all eight static HTML pages exist in `frontend/out` and that zero `http://localhost:8000` references leaked into compiled HTML or JavaScript bundles:

```bash
cd frontend
for page in index.html login.html dashboard.html orders.html inventory.html reports.html users.html 404.html; do
  test -f "out/$page"
done
test "$(find out -maxdepth 1 -name '*.html' | wc -l | tr -d ' ')" -eq 8
! grep -rnF 'http://localhost:8000' out/
```

Generate and verify the deterministic SHA-256 checksum manifest (`out/manifest.sha256`) attested in CI:

```bash
cd frontend/out
find . -type f ! -name 'manifest.sha256' -print0 \
  | LC_ALL=C sort -z \
  | xargs -0 sha256sum > manifest.sha256
sha256sum -c manifest.sha256
```

### 8. Firebase Hosting & CI Workflow Validation

Validate `frontend/firebase.json` (`public: "out"`, `cleanUrls: true`, and Cloud Run rewrites targeting `coffee-backend` in `us-central1` for `/api/**`, `/auth/**`, `/dashboard/**`, `/orders/**`, `/inventory/**`, `/reports/**`, `/users/**`, and `/ws/**`) and confirm `frontend/.firebaserc` has no placeholder project ID:

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
```

Validate CI/CD workflow schemas from the repository root:

```bash
check-jsonschema --builtin-schema vendor.github-workflows .github/workflows/ci.yml .github/workflows/deploy-frontend.yml
check-jsonschema --builtin-schema vendor.cloudbuild backend/cloudbuild.yaml frontend/cloudbuild.yaml
```

Deploy `frontend/out` to Firebase Hosting explicitly passing `FIREBASE_PROJECT_ID`:

```bash
cd frontend
npx --yes firebase-tools deploy --only hosting --project "$FIREBASE_PROJECT_ID"
```

## Guardrails

- Keep `"strict": true`, `"skipLibCheck": false`, `"noUnusedLocals": true`, and `"noUnusedParameters": true` enabled in `frontend/tsconfig.json`.
- Avoid explicit `any` annotations; share API payload interfaces via `frontend/types/api.ts` (matching `backend/app/schemas.py`) and narrow `unknown` errors with `axios.isAxiosError`.
- Do not add workflow path filters to `.github/workflows/ci.yml` that could skip required branch-protection checks.
- Keep CI token permissions read-only (`contents: read`) unless a job explicitly publishes artifacts or attestations.
- Never allow `http://localhost:8000` fallbacks in production frontend builds (`frontend/out`).
- Remove untracked local artifacts (`backend/dev.db`, `frontend/tsconfig.tsbuildinfo`, `frontend/package-lock.json`) before committing.
