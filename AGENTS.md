# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions, deterministic dependency management, pre-commit guardrails, container release/provenance guardrails, architecture details, and exact local verification commands that mirror `.github/workflows/ci.yml`, `.github/workflows/deploy-frontend.yml`, `backend/cloudbuild.yaml`, and `frontend/cloudbuild.yaml`.

## Repository Structure & Architecture

- `backend/` — FastAPI, SQLAlchemy 2.0.x, JWT (`python-jose` + `passlib`/bcrypt), and `python-socketio` ASGI backend running on Python 3.11 (`app/main.py`, `seed.py`, `tests/`, `pyproject.toml`, `requirements.in`, `requirements.txt`, `Dockerfile`, `.dockerignore`, `cloudbuild.yaml`) deployed to Cloud Run as `coffee-backend` in `us-central1`.
  - REST routers in `backend/app/main.py`: `/auth`, `/dashboard`, `/orders`, `/inventory`, `/reports`, `/users`.
  - Socket.IO ASGI endpoint in `backend/app/websockets.py`: mounted at `/ws` with `socketio_path='/ws/socket.io'`.
- `frontend/` — Next.js `14.1.0` (Pages Router, TypeScript, Tailwind CSS, Radix UI Toast, `socket.io-client`) frontend (`package.json`, `package-lock.json`, `tsconfig.json`, `next.config.js`, `.eslintrc.json`, `.prettierrc.json`, `firebase.json`, `cloudbuild.yaml`) configured for static HTML export (`output: 'export'`, `images: { unoptimized: true }`) into `frontend/out` and deployed to Firebase Hosting (`cleanUrls: true`).
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
NEXT_PUBLIC_API_URL=/ npm run build
```

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

## Backend Container & Cloud Build Guidelines

The backend service (`backend/`) builds an immutable Docker image, runs an ephemeral smoke/test gate before pushing, and deploys to Cloud Run via Google Cloud Build (`backend/cloudbuild.yaml`).

### Release & Provenance Guardrails

- **No mutable `:latest` tags**: Every build in `backend/cloudbuild.yaml` tags the image with `$BUILD_ID` (and `$COMMIT_SHA` whenever Git metadata is present) and never builds, tests, pushes, or deploys an untagged `:latest` reference.
- **Manual `gcloud builds submit` compatibility**: Always keep `$BUILD_ID` as the unconditional tag and top-level `images` entry so manual `gcloud builds submit --config backend/cloudbuild.yaml backend` runs succeed even when `$COMMIT_SHA` is empty.
- **Deploy by `@sha256:` digest**: The `push-image` step resolves the pushed `@sha256:` digest from Artifact Registry (`RepoDigests`), writes it to `/workspace/image-digest.txt`, and passes that digest to `gcloud run deploy --image` in `deploy-cloud-run`.
- **SLSA build provenance**: `backend/cloudbuild.yaml` registers `${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID` in top-level `images` and sets `options.requestedVerifyOption: VERIFIED` so Cloud Build generates verified SLSA provenance attestations in Artifact Registry. Note that **full SLSA Level 3 source provenance requires trigger-driven builds from connected repositories** (manual `gcloud builds submit` uploads local source archives rather than fetching directly from a verified Git trigger).
- **Pinned base image & filtered build context**: `backend/Dockerfile` pins `python:3.11-slim` by `@sha256:` digest, and `backend/.dockerignore` excludes `cloudbuild.yaml`, `Dockerfile`, `seed.py`, `app/routers/_init_.py`, `tests/`, `.env*`, `.venv/`, `__pycache__/`, and `*.db` from the production container image (while `test-image` streams `seed.py` and `tests/` into an ephemeral `docker run --rm -i` container without polluting the pushed image).

## Local Verification Commands (CI & Cloud Build Parity)

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

### 5. Backend Container & Cloud Build Pipeline Gate

1. **Validate `backend/cloudbuild.yaml` syntax and provenance invariants**:

   ```bash
   yq -e '.options.requestedVerifyOption == "VERIFIED" and (.images | length > 0) and (.steps | length == 4)' backend/cloudbuild.yaml
   ```

   Or with Python (`PyYAML`):

   ```bash
   python3 -c '
   import pathlib, re, yaml
   raw = pathlib.Path("backend/cloudbuild.yaml").read_text()
   cfg = yaml.safe_load(raw)
   assert cfg["options"]["requestedVerifyOption"] == "VERIFIED"
   assert "${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID" in cfg["images"]
   assert [s["id"] for s in cfg["steps"]] == ["build-image", "test-image", "push-image", "deploy-cloud-run"]
   assert not re.search(r"coffee-repo/coffee-backend(?![:@])|:latest\b", raw)
   print("cloudbuild.yaml validation passed")
   '
   ```

2. **Build `backend/Dockerfile` and inspect built image contents** (verify `.dockerignore` excludes `cloudbuild.yaml`, `Dockerfile`, `seed.py`, `app/routers/_init_.py`, `tests/`, `.env*`, `.venv/`, `__pycache__/`, and `*.db`):

   ```bash
   docker build -t coffee-backend:local backend
   docker run --rm --entrypoint find coffee-backend:local /app -mindepth 1 -maxdepth 3 | sort
   ```

3. **Run ephemeral container smoke and `pytest` gate** (reproduces `test-image` in `backend/cloudbuild.yaml` without baking tests or seed scripts into `coffee-backend:local`):

   ```bash
   cd backend
   tar -cf - seed.py tests | docker run --rm -i \
     -e JWT_SECRET="cloudbuild-test-jwt-secret-key" \
     coffee-backend:local \
     sh -ceu '
       tar -xf - -C /app
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

```bash
cd frontend
npm ci --no-audit --no-fund

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
NEXT_PUBLIC_API_URL=/ NEXT_TELEMETRY_DISABLED=1 npm run build
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

- Do not ignore `frontend/package-lock.json` in `.gitignore` or hand-edit `backend/requirements.txt` without SHA-256 hashes.
- Keep `"strict": true`, `"skipLibCheck": false`, `"noUnusedLocals": true`, and `"noUnusedParameters": true` enabled in `frontend/tsconfig.json`.
- Avoid explicit `any` annotations; share API payload interfaces via `frontend/types/api.ts` (matching `backend/app/schemas.py`) and narrow `unknown` errors with `axios.isAxiosError`.
- Do not add workflow path filters to `.github/workflows/ci.yml` that could skip required branch-protection checks.
- Keep CI token permissions read-only (`contents: read`) unless a job explicitly publishes artifacts or attestations.
- Never allow `http://localhost:8000` fallbacks in production frontend builds (`frontend/out`).
- Remove untracked local artifacts (`backend/dev.db`, `frontend/tsconfig.tsbuildinfo`) before committing.
