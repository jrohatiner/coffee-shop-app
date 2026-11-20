# AGENTS.md

## Backend Container & Cloud Build Guidelines

The backend service (`backend/`) builds an immutable Docker image and deploys to Cloud Run via Google Cloud Build (`backend/cloudbuild.yaml`).

### Release & Provenance Guardrails

- **No mutable `:latest` tags**: Every build in `backend/cloudbuild.yaml` tags the image with `$BUILD_ID` (and `$COMMIT_SHA` whenever Git metadata is present) and never builds, pushes, or deploys an untagged `:latest` reference.
- **Manual `gcloud builds submit` compatibility**: Always keep `$BUILD_ID` as the unconditional tag and top-level `images` entry so manual `gcloud builds submit --config backend/cloudbuild.yaml backend` runs succeed even when `$COMMIT_SHA` is empty.
- **Deploy by `@sha256:` digest**: The push step resolves the pushed `@sha256:` digest from Artifact Registry (`RepoDigests`), writes it to `/workspace/image-digest.txt`, and passes that digest to `gcloud run deploy --image`.
- **SLSA build provenance**: `backend/cloudbuild.yaml` registers `${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID` in top-level `images` and sets `options.requestedVerifyOption: VERIFIED` so Cloud Build generates verified SLSA provenance attestations in Artifact Registry. Note that **full SLSA Level 3 source provenance requires trigger-driven builds from connected repositories** (manual `gcloud builds submit` uploads local source archives rather than fetching directly from a verified Git trigger).
- **Pinned base image & filtered build context**: `backend/Dockerfile` pins `python:3.11-slim` by `@sha256:` digest, and `backend/.dockerignore` excludes `cloudbuild.yaml`, `Dockerfile`, `seed.py`, `app/routers/_init_.py`, `tests/`, `.env*`, `.venv/`, `__pycache__/`, and `*.db` from the production container image.

### Local Container & Pipeline Checks

Run these checks from the repository root before pushing changes to `backend/Dockerfile`, `backend/.dockerignore`, or `backend/cloudbuild.yaml`:

1. **Validate `backend/cloudbuild.yaml` syntax and provenance invariants**:
   ```bash
   yq -e '.options.requestedVerifyOption == "VERIFIED" and (.images | length > 0) and (.steps | length == 3)' backend/cloudbuild.yaml
   ```
   Or with Python (`PyYAML`):
   ```bash
   python3 -c '
   import pathlib, re, yaml
   raw = pathlib.Path("backend/cloudbuild.yaml").read_text()
   cfg = yaml.safe_load(raw)
   assert cfg["options"]["requestedVerifyOption"] == "VERIFIED"
   assert "${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID" in cfg["images"]
   assert not re.search(r"coffee-repo/coffee-backend(?![:@])|:latest\b", raw)
   print("cloudbuild.yaml validation passed")
   '
   ```

2. **Build `backend/Dockerfile` locally**:
   ```bash
   docker build -t coffee-backend:local backend
   ```

3. **Inspect built image contents** (verify `.dockerignore` excludes `cloudbuild.yaml`, `Dockerfile`, `seed.py`, `app/routers/_init_.py`, `tests/`, `.env*`, `.venv/`, `__pycache__/`, and `*.db`):
   ```bash
   docker run --rm --entrypoint find coffee-backend:local /app -mindepth 1 -maxdepth 3 | sort
   ```
