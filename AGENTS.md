# AGENTS.md

## Frontend Checks (`frontend/`)

Run all static analysis, formatting, build, and test checks from `frontend/` before committing frontend changes:

```bash
cd frontend

# Strict TypeScript typechecking (tsc --noEmit)
npm run typecheck

# Non-interactive Next.js ESLint check (next lint --max-warnings 0)
npm run lint

# Prettier formatting check (prettier --check .)
npm run format:check

# Auto-format frontend files with Prettier (prettier --write .)
npm run format

# Production Next.js build
npm run build

# Unit and E2E tests
npm run test:unit
npm run test:e2e
```

### Guidelines
- Keep `"strict": true`, `"skipLibCheck": false`, `"noUnusedLocals": true`, and `"noUnusedParameters": true` enabled in `frontend/tsconfig.json`.
- Avoid explicit `any` annotations; share API payload interfaces via `frontend/types/api.ts` (matching `backend/app/schemas.py`) and narrow `unknown` errors with `axios.isAxiosError`.

## Backend Checks (`backend/`)

```bash
cd backend
pytest
```
