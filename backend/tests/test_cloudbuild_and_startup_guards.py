import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
CLOUDBUILD_PATH = BACKEND_DIR / "cloudbuild.yaml"
BOOTSTRAP_PATH = REPO_ROOT / "bootstrap_coffee_shop.sh"
ENV_EXAMPLE_PATH = BACKEND_DIR / ".env.example"
GITIGNORE_PATH = REPO_ROOT / ".gitignore"
AGENTS_MD_PATH = REPO_ROOT / "AGENTS.md"
REQUIREMENTS_PATH = BACKEND_DIR / "requirements.txt"
REQUIREMENTS_IN_PATH = BACKEND_DIR / "requirements.in"


def _has_requirement_spec(path: Path, package_name: str) -> bool:
    pattern = re.compile(rf"^{re.escape(package_name)}(?:$|[=<>!~;\s\\])")
    return any(
        pattern.match(line.strip())
        for line in path.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def _parse_gcloud_dict_flag(raw_value: str) -> dict[str, str]:
    """Emulate gcloud topic escaping ArgDict parsing (default ',' vs '^DELIM^')."""
    delimiter = ","
    payload = raw_value
    if payload.startswith("^") and len(payload) >= 3:
        second_caret = payload.find("^", 1)
        if second_caret > 1:
            delimiter = payload[1:second_caret]
            payload = payload[second_caret + 1 :]
    result: dict[str, str] = {}
    for item in payload.split(delimiter):
        if "=" not in item:
            raise ValueError(f"Malformed gcloud key=value token: {item!r}")
        key, val = item.split("=", 1)
        if not key:
            raise ValueError(f"Empty key in gcloud flag token: {item!r}")
        result[key] = val
    return result


def _render_cloudbuild_arg(
    arg: str, substitutions: dict[str, str], project_id: str = "prod-coffee-123"
) -> str:
    rendered = arg.replace("$PROJECT_ID", project_id).replace(
        "${PROJECT_ID}", project_id
    )
    for key, val in substitutions.items():
        rendered = rendered.replace(f"${{{key}}}", val).replace(f"${key}", val)
    # Cloud Build unescapes '$$' -> '$' before invoking container entrypoint
    rendered = rendered.replace("$$", "$")
    return rendered


def _run_predeploy_step(overrides: dict[str, str]) -> subprocess.CompletedProcess[str]:
    if not CLOUDBUILD_PATH.exists():
        pytest.skip("cloudbuild.yaml excluded from container context")
    cfg = yaml.safe_load(CLOUDBUILD_PATH.read_text())
    subs = {**cfg["substitutions"], **overrides}
    step = cfg["steps"][0]
    assert step["entrypoint"] == "bash"
    rendered_args: list[str] = [_render_cloudbuild_arg(a, subs) for a in step["args"]]
    return subprocess.run(
        ["bash", *rendered_args],
        capture_output=True,
        text=True,
        check=False,
    )


def _run_isolated_import(
    module_name: str, env_vars: dict[str, str], cwd: Path = BACKEND_DIR
) -> subprocess.CompletedProcess[str]:
    clean_env = {
        "PATH": "/usr/bin:/bin",
        "PYTHONPATH": str(BACKEND_DIR),
        **env_vars,
    }
    code = (
        "import sys\n"
        f"try:\n    import {module_name}\n"
        "except Exception as exc:\n"
        "    assert isinstance(exc, RuntimeError), "
        "f'Expected RuntimeError, got {type(exc)}'\n"
        "    print(f'{type(exc).__name__}: {exc}', file=sys.stderr)\n"
        "    sys.exit(2)\n"
    )
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(cwd),
        env=clean_env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_cloudbuild_yaml_hardened_structure_and_no_plaintext_secrets():
    if not CLOUDBUILD_PATH.exists():
        pytest.skip("cloudbuild.yaml excluded from container context")
    raw_text = CLOUDBUILD_PATH.read_text()
    assert "replace-me" not in raw_text
    assert "_DB_PASS" not in raw_text
    assert not re.search(
        r"coffee-repo/coffee-backend(?![:@])|coffee-repo/coffee-backend:latest\b",
        raw_text,
    )

    cfg = yaml.safe_load(raw_text)
    assert isinstance(cfg, dict)
    assert (
        cfg.get("serviceAccount")
        == "projects/$PROJECT_ID/serviceAccounts/${_BUILD_SERVICE_ACCOUNT}"
    )
    assert cfg.get("options", {}).get("logging") == "CLOUD_LOGGING_ONLY"
    assert cfg.get("options", {}).get("requestedVerifyOption") == "VERIFIED"
    assert (
        "${_REGION}-docker.pkg.dev/$PROJECT_ID/coffee-repo/coffee-backend:$BUILD_ID"
        in cfg.get("images", [])
    )
    assert "availableSecrets" not in cfg

    subs = cfg.get("substitutions", {})
    assert "_DB_PASS" not in subs
    assert "_JWT_SECRET" not in subs
    assert "_DB_URL_SECRET" in subs
    assert "_JWT_SECRET_NAME" in subs
    assert "_BUILD_SERVICE_ACCOUNT" in subs
    assert "_RUN_SERVICE_ACCOUNT" in subs
    assert all(val != "replace-me" for val in subs.values())

    for step in cfg["steps"]:
        assert "secretEnv" not in step
        assert "availableSecrets" not in step

    step_ids = [step.get("id") for step in cfg["steps"]]
    assert step_ids == [
        "validate-substitutions",
        "build-image",
        "test-image",
        "push-image",
        "deploy-cloud-run",
    ]

    deploy_step = cfg["steps"][-1]
    assert deploy_step["entrypoint"] == "bash"
    assert "env" not in deploy_step
    args = deploy_step["args"]
    assert (
        'exec gcloud run deploy coffee-backend --image="$$IMAGE_DIGEST" "$$@"'
        in (args[1])
    )
    assert "--allow-unauthenticated" in args
    assert "--service-account=${_RUN_SERVICE_ACCOUNT}" in args
    assert (
        "--set-env-vars=^|^"
        "INSTANCE_UNIX_SOCKET=${_CLOUD_SQL_INSTANCE}|APP_ENV=production" in args
    )
    assert (
        "--set-secrets="
        "DATABASE_URL=${_DB_URL_SECRET}:latest,"
        "JWT_SECRET=${_JWT_SECRET_NAME}:latest" in args
    )


def test_gcloud_arg_parsing_handles_commas_equals_and_colons_in_secret_payloads():
    if not CLOUDBUILD_PATH.exists():
        pytest.skip("cloudbuild.yaml excluded from container context")
    cfg = yaml.safe_load(CLOUDBUILD_PATH.read_text())
    build_sa = "coffee-build@prod-coffee-123.iam.gserviceaccount.com"
    run_sa = "coffee-run@prod-coffee-123.iam.gserviceaccount.com"
    valid_subs = {
        **cfg["substitutions"],
        "_CLOUD_SQL_INSTANCE": "prod-coffee-123:us-central1:coffee-db",
        "_BUILD_SERVICE_ACCOUNT": build_sa,
        "_RUN_SERVICE_ACCOUNT": run_sa,
        "_DB_URL_SECRET": "coffee-db-url",
        "_JWT_SECRET_NAME": "coffee-jwt-secret",
    }
    deploy_args = [
        _render_cloudbuild_arg(a, valid_subs) for a in cfg["steps"][-1]["args"]
    ]

    env_flag = next(a for a in deploy_args if a.startswith("--set-env-vars="))
    secrets_flag = next(a for a in deploy_args if a.startswith("--set-secrets="))

    parsed_env = _parse_gcloud_dict_flag(env_flag.split("=", 1)[1])
    assert parsed_env == {
        "INSTANCE_UNIX_SOCKET": "prod-coffee-123:us-central1:coffee-db",
        "APP_ENV": "production",
    }

    parsed_secrets = _parse_gcloud_dict_flag(secrets_flag.split("=", 1)[1])
    assert parsed_secrets == {
        "DATABASE_URL": "coffee-db-url:latest",
        "JWT_SECRET": "coffee-jwt-secret:latest",
    }

    # Secret Manager payloads with commas, equals signs, and colons are mounted
    # at runtime rather than parsed by gcloud --set-env-vars, so both succeed.
    complex_db_secret_payload = (
        "postgresql://postgres:pass,w=rd:with:colons@localhost:5432/coffee"
        "?options=-c%20statement_timeout=5000"
    )
    complex_jwt_secret_payload = "k3y,with=commas:and:colons-0123456789abcdef!"
    assert len(complex_jwt_secret_payload) >= 32

    res = _run_isolated_import(
        "app.auth, app.database",
        {
            **parsed_env,
            "K_SERVICE": "coffee-backend",
            "DATABASE_URL": complex_db_secret_payload,
            "JWT_SECRET": complex_jwt_secret_payload,
        },
    )
    assert res.returncode == 0, res.stderr


VALID_BUILD_SA = "coffee-build@prod-coffee-123.iam.gserviceaccount.com"
VALID_RUN_SA = "coffee-run@prod-coffee-123.iam.gserviceaccount.com"
PLACEHOLDER_BUILD_SA = "coffee-build@YOUR_PROJECT_ID.iam.gserviceaccount.com"
PROD_DB_URL = "postgresql://postgres:strong-prod-db-pass-987654@localhost:5432/coffee"


@pytest.mark.parametrize(
    "overrides,expected_var",
    [
        ({}, "_CLOUD_SQL_INSTANCE"),
        (
            {
                "_CLOUD_SQL_INSTANCE": "YOUR_PROJECT_ID:us-central1:coffee-db",
                "_BUILD_SERVICE_ACCOUNT": VALID_BUILD_SA,
                "_RUN_SERVICE_ACCOUNT": VALID_RUN_SA,
            },
            "_CLOUD_SQL_INSTANCE",
        ),
        (
            {
                "_CLOUD_SQL_INSTANCE": "prod-coffee-123:us-central1:coffee-db",
                "_BUILD_SERVICE_ACCOUNT": PLACEHOLDER_BUILD_SA,
                "_RUN_SERVICE_ACCOUNT": VALID_RUN_SA,
            },
            "_BUILD_SERVICE_ACCOUNT",
        ),
        (
            {
                "_CLOUD_SQL_INSTANCE": "prod-coffee-123:us-central1:coffee-db",
                "_BUILD_SERVICE_ACCOUNT": VALID_BUILD_SA,
                "_RUN_SERVICE_ACCOUNT": "replace-me",
            },
            "_RUN_SERVICE_ACCOUNT",
        ),
        (
            {
                "_CLOUD_SQL_INSTANCE": "prod-coffee-123:us-central1:coffee-db",
                "_BUILD_SERVICE_ACCOUNT": VALID_BUILD_SA,
                "_RUN_SERVICE_ACCOUNT": "",
            },
            "_RUN_SERVICE_ACCOUNT",
        ),
    ],
)
def test_cloudbuild_predeploy_step_rejects_placeholders(overrides, expected_var):
    res = _run_predeploy_step(overrides)
    assert res.returncode != 0
    assert expected_var in res.stderr


def test_cloudbuild_predeploy_step_accepts_configured_substitutions():
    res = _run_predeploy_step(
        {
            "_CLOUD_SQL_INSTANCE": "prod-coffee-123:us-central1:coffee-db",
            "_BUILD_SERVICE_ACCOUNT": VALID_BUILD_SA,
            "_RUN_SERVICE_ACCOUNT": VALID_RUN_SA,
            "_DB_URL_SECRET": "coffee-db-url",
            "_JWT_SECRET_NAME": "coffee-jwt-secret",
        }
    )
    assert res.returncode == 0, res.stderr


@pytest.mark.parametrize(
    "prod_marker", [{"K_SERVICE": "coffee-backend"}, {"APP_ENV": "production"}]
)
@pytest.mark.parametrize(
    "bad_jwt_secret",
    [
        "replace-me",
        "dev_secret_key",
        "YOUR_PROJECT_ID",
        "YOUR_DB_PASSWORD",
        "short-key-under-32-characters!!",  # 31 chars
        "local-dev-secret-not-for-production",
    ],
)
@pytest.mark.parametrize("module_name", ["app.auth", "app.database"])
def test_production_startup_rejects_placeholder_and_weak_jwt_secrets(
    prod_marker, bad_jwt_secret, module_name
):
    res = _run_isolated_import(
        module_name,
        {
            **prod_marker,
            "DATABASE_URL": PROD_DB_URL,
            "INSTANCE_UNIX_SOCKET": "prod-coffee-123:us-central1:coffee-db",
            "JWT_SECRET": bad_jwt_secret,
        },
    )
    assert res.returncode == 2, (
        f"Expected RuntimeError for {module_name} with {bad_jwt_secret!r}"
    )
    assert bad_jwt_secret not in res.stderr


@pytest.mark.parametrize(
    "prod_marker", [{"K_SERVICE": "coffee-backend"}, {"APP_ENV": "production"}]
)
@pytest.mark.parametrize(
    "db_env",
    [
        {},
        {"DATABASE_URL": ""},
        {"DATABASE_URL": "sqlite:///./dev.db"},
        {"DATABASE_URL": "postgresql://postgres:replace-me@localhost:5432/coffee"},
        {"DATABASE_URL": "postgresql://postgres:dev_secret_key@localhost:5432/coffee"},
        {
            "DATABASE_URL": (
                "postgresql://postgres:YOUR_DB_PASSWORD@localhost:5432/coffee"
            )
        },
        {"DATABASE_URL": "postgresql://postgres:pass@YOUR_PROJECT_ID:5432/coffee"},
        {
            "DATABASE_URL": PROD_DB_URL,
            "INSTANCE_UNIX_SOCKET": "YOUR_PROJECT_ID:us-central1:coffee-db",
        },
        {
            "DATABASE_URL": PROD_DB_URL,
            "INSTANCE_UNIX_SOCKET": "replace-me",
        },
    ],
)
def test_production_database_startup_rejects_missing_or_placeholder_db_config(
    prod_marker, db_env
):
    res = _run_isolated_import(
        "app.database",
        {
            **prod_marker,
            "JWT_SECRET": "strong-production-jwt-signing-key-0123456789",
            **db_env,
        },
    )
    assert res.returncode == 2, f"Expected RuntimeError for db_env={db_env!r}"


def test_local_env_example_workflow_preserved_without_production_flags(tmp_path):
    if not ENV_EXAMPLE_PATH.exists():
        pytest.skip(".env.example excluded from container context")
    local_env_file = tmp_path / ".env"
    local_env_file.write_text(ENV_EXAMPLE_PATH.read_text())

    res = _run_isolated_import("app.database, app.auth", {}, cwd=tmp_path)
    assert res.returncode == 0, res.stderr


def test_bootstrap_script_synchronized_with_hardened_templates():
    if not BOOTSTRAP_PATH.exists():
        pytest.skip("Bootstrap script absent in standalone container context")
    bootstrap_text = BOOTSTRAP_PATH.read_text()

    cb_match = re.search(
        r"cat > backend/cloudbuild\.yaml << 'EOF'\n(.*?)\nEOF",
        bootstrap_text,
        re.DOTALL,
    )
    assert cb_match is not None
    assert cb_match.group(1).strip() == CLOUDBUILD_PATH.read_text().strip()
    bootstrap_cb = yaml.safe_load(cb_match.group(1))
    assert "_DB_PASS" not in bootstrap_cb["substitutions"]
    assert "_JWT_SECRET" not in bootstrap_cb["substitutions"]
    assert "_JWT_SECRET_NAME" in bootstrap_cb["substitutions"]
    assert "replace-me" not in cb_match.group(1)

    env_match = re.search(
        r"cat > backend/\.env\.example << 'EOF'\n(.*?)\nEOF",
        bootstrap_text,
        re.DOTALL,
    )
    assert env_match is not None
    assert env_match.group(1).strip() == ENV_EXAMPLE_PATH.read_text().strip()


def test_gitignore_tracks_env_example_and_docs_exist():
    assert _has_requirement_spec(REQUIREMENTS_PATH, "psycopg2-binary")
    if REQUIREMENTS_IN_PATH.exists():
        assert _has_requirement_spec(REQUIREMENTS_IN_PATH, "psycopg2-binary")
    if not (REPO_ROOT / ".git").exists():
        pytest.skip("Git metadata absent in standalone container context")
    gitignore_lines = [line.strip() for line in GITIGNORE_PATH.read_text().splitlines()]
    assert "!.env.example" in gitignore_lines

    check_ignore_example = subprocess.run(
        ["git", "check-ignore", "backend/.env.example"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert check_ignore_example.returncode != 0

    ls_files_example = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "backend/.env.example"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert ls_files_example.returncode == 0

    check_ignore_real_env = subprocess.run(
        ["git", "check-ignore", "backend/.env"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert check_ignore_real_env.returncode == 0

    assert AGENTS_MD_PATH.is_file()
    agents_text = AGENTS_MD_PATH.read_text()
    assert "backend/.env.example" in agents_text
    assert "git check-ignore" in agents_text
    assert "cloudbuild.yaml" in agents_text
