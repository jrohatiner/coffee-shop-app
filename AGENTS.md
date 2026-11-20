# Repository Guidelines & Verification (`AGENTS.md`)

## Secret Management & Deployment Guardrails

- **No Plaintext Secrets in Build Configs**: `backend/cloudbuild.yaml` and `bootstrap_coffee_shop.sh` must never define plaintext password or signing-key substitutions (such as `_DB_PASS` or `_JWT_SECRET`) or `'replace-me'` defaults.
- **Cloud Run Secret Manager Bindings**: `DATABASE_URL` and `JWT_SECRET` are bound at runtime on Cloud Run via `--set-secrets=DATABASE_URL=${_DB_URL_SECRET}:latest,JWT_SECRET=${_JWT_SECRET_NAME}:latest`. Do not inject secret payloads into Cloud Build `availableSecrets` or `secretEnv`.
- **Dedicated Least-Privilege Identities**: Cloud Build executes under `projects/$PROJECT_ID/serviceAccounts/${_BUILD_SERVICE_ACCOUNT}` with `options.logging: CLOUD_LOGGING_ONLY`, and Cloud Run executes under `--service-account=${_RUN_SERVICE_ACCOUNT}`.
- **Custom Delimiter for Non-Secret Env Vars**: `gcloud run deploy` passes non-secret environment variables using `--set-env-vars=^|^INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE}|APP_ENV=production` so colons in Cloud SQL connection names never collide with `gcloud` argument delimiters.
- **Production Startup Guards**: When `APP_ENV=production` or `K_SERVICE` is set, `app.auth` and `app.database` reject placeholder values (`replace-me`, `dev_secret_key`, `YOUR_PROJECT_ID`, `YOUR_DB_PASSWORD`), unconfigured `DATABASE_URL` / `INSTANCE_UNIX_SOCKET` values, and any `JWT_SECRET` shorter than 32 characters with `RuntimeError`.

## Local Environment Setup

Copy the tracked template `backend/.env.example` to `backend/.env` (which remains ignored by Git) before starting the backend locally:

```bash
cp backend/.env.example backend/.env
```

For local SQLite development, the defaults in `backend/.env.example` work out of the box (`APP_ENV=development`, `DATABASE_URL=sqlite:///./dev.db`). For local PostgreSQL, uncomment and update `DATABASE_URL` in `backend/.env`.

## Local Verification Commands

Run these checks from the repository root before committing deployment or configuration changes:

### 1. Verify `.gitignore` & Tracked `.env.example`

```bash
# Must exit non-zero (not ignored) and show backend/.env.example is tracked:
! git check-ignore -q backend/.env.example
git ls-files --error-unmatch backend/.env.example

# Confirm real .env files remain ignored by Git:
git check-ignore -q backend/.env
```

### 2. Validate `backend/cloudbuild.yaml` & Pre-Deploy Substitution Guard

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
```

### 3. Verify Production Startup Guards (`app.auth` & `app.database`)

```bash
cd backend

# Must raise RuntimeError in production when placeholder or <32-char secrets are supplied:
python3 -c '
import os, subprocess, sys

for mod in ("app.auth", "app.database"):
    env = {**os.environ, "K_SERVICE": "coffee-backend", "JWT_SECRET": "replace-me"}
    res = subprocess.run([sys.executable, "-c", f"import {mod}"], env=env, capture_output=True, text=True)
    assert res.returncode != 0 and ("RuntimeError" in res.stderr or "ConfigurationError" in res.stderr), res.stderr
print("Production startup guards verified.")
'

# Run unit tests for auth, startup guards, and Cloud Build configuration:
PYTHONPATH=. pytest tests/test_auth_configuration.py tests/test_cloudbuild_and_startup_guards.py
```
