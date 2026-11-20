# AGENTS.md

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
