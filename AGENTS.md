# AGENTS.md

Guidelines and local verification commands for contributors and coding agents working in `coffee-shop-app`.

## Architecture Overview

- **Frontend (`frontend/`)**: Next.js `14.1.0` (Pages Router, TypeScript, Tailwind CSS) configured for static HTML export (`output: 'export'`, `images: { unoptimized: true }`) into `frontend/out` and deployed to Firebase Hosting (`cleanUrls: true`).
- **Backend (`backend/`)**: FastAPI + SQLAlchemy + `python-socketio` ASGI service deployed to Cloud Run as `coffee-backend` in `us-central1` (`backend/cloudbuild.yaml`).
  - REST routers in `backend/app/main.py`: `/auth`, `/dashboard`, `/orders`, `/inventory`, `/reports`, `/users`.
  - Socket.IO ASGI endpoint in `backend/app/websockets.py`: mounted at `/ws` with `socketio_path='/ws/socket.io'`.
- **Environment Variables (Frontend)**:
  - `NEXT_PUBLIC_API_URL`: Base URL for Axios REST calls (`frontend/lib/api.ts`). Required for release builds; never falls back to `http://localhost:8000` in production (`NODE_ENV=production`).
  - `NEXT_PUBLIC_SOCKET_URL`: Optional direct origin for Socket.IO (`frontend/hooks/useSocket.ts`) to connect directly to Cloud Run (`coffee-backend`) when CDN rewrites strip WebSocket `Upgrade` headers. Falls back to `NEXT_PUBLIC_API_URL` (or same-origin `/ws/socket.io` when relative/unset in production).
  - `FIREBASE_PROJECT_ID`: Explicit target Firebase project passed via `--project "$FIREBASE_PROJECT_ID"` (`frontend/.firebaserc` intentionally omits hardcoded project aliases).

## Local Frontend Setup, Typecheck, and Unit Tests

`frontend/` tracks `package.json` without a lockfile. Install dependencies without generating an untracked `package-lock.json`:

```bash
cd frontend
npm install --no-package-lock --legacy-peer-deps --no-audit --no-fund
```

Run strict TypeScript checks and unit test suites (mirrors CI `verify` job):

```bash
cd frontend
npx tsc --noEmit
npm run test:unit
node --test __tests__/orderState.test.mjs
```

## Static Next.js Build, Export, and Bundle Audit

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

## Firebase Hosting & CI Workflow Validation

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
check-jsonschema --builtin-schema vendor.github-workflows .github/workflows/deploy-frontend.yml
check-jsonschema --builtin-schema vendor.cloudbuild frontend/cloudbuild.yaml
```

Deploy `frontend/out` to Firebase Hosting explicitly passing `FIREBASE_PROJECT_ID`:

```bash
cd frontend
npx --yes firebase-tools deploy --only hosting --project "$FIREBASE_PROJECT_ID"
```
