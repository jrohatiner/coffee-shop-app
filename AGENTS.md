# AGENTS.md — Coffee Shop Ordering System

This file defines repository conventions, container release/provenance guardrails, and exact local verification commands that mirror `.github/workflows/ci.yml` and `backend/cloudbuild.yaml`.

## Repository Structure

- `backend/` — FastAPI, SQLAlchemy, JWT (`python-jose` + `passlib`), and Socket.IO backend (`app/main.py`, `seed.py`, `tests/`, `Dockerfile`, `.dockerignore`, `cloudbuild.yaml`).
- `frontend/` — Next.js 14 (Pages Router, TypeScript, Tailwind CSS) frontend (`package.json`, `tsconfig.json`, `next.config.js`).
- `.github/workflows/ci.yml` — Parallel `backend-checks` and `frontend-build` GitHub Actions jobs triggered on pushes and pull requests to `main`.

## Required Environment Variables

- `JWT_SECRET`: **Required** whenever `app.auth` or `app.main` is imported. Must be at least 8 characters and must not match insecure placeholders (`dev_secret_key`, `secret`, `password`, `changeme`, `replace-me`, `replace-with-strong-random`).
- `DATABASE_URL`: Optional for local runs and smoke checks. When unset or blank, `backend/app/database.py` defaults to `sqlite:///./dev.db` with `check_same_thread=False`. Set `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coffee_test` to target PostgreSQL.

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
