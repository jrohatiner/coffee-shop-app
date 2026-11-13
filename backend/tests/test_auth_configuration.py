import importlib
import os
import pytest
from app.auth import ConfigurationError, get_jwt_secret

def test_missing_jwt_secret_raises_configuration_error(monkeypatch):
    """Refuses startup/execution when JWT_SECRET is unset."""
    monkeypatch.delenv("JWT_SECRET", raising=False)
    with pytest.raises(RuntimeError) as exc_info:
        get_jwt_secret()
    assert issubclass(ConfigurationError, RuntimeError)
    assert issubclass(ConfigurationError, ValueError)
    assert isinstance(exc_info.value, ConfigurationError)
    assert "missing or blank" in str(exc_info.value)

def test_empty_jwt_secret_raises_configuration_error(monkeypatch):
    """Refuses startup/execution when JWT_SECRET is empty string."""
    monkeypatch.setenv("JWT_SECRET", "")
    with pytest.raises(ConfigurationError) as exc_info:
        get_jwt_secret()
    assert "missing or blank" in str(exc_info.value)

def test_whitespace_jwt_secret_raises_configuration_error(monkeypatch):
    """Refuses startup/execution when JWT_SECRET is blank/whitespace."""
    monkeypatch.setenv("JWT_SECRET", "   \t\n  ")
    with pytest.raises(ConfigurationError) as exc_info:
        get_jwt_secret()
    assert "missing or blank" in str(exc_info.value)

def test_dev_secret_key_fallback_is_rejected_as_insecure(monkeypatch):
    """Rejects static fallback string dev_secret_key as insecure."""
    monkeypatch.setenv("JWT_SECRET", "dev_secret_key")
    with pytest.raises(ConfigurationError) as exc_info:
        get_jwt_secret()
    assert "insecure" in str(exc_info.value).lower()
    # Guardrail: secret key must not be leaked in exception message
    assert "dev_secret_key" not in str(exc_info.value)

def test_short_jwt_secret_rejected_as_insecure(monkeypatch):
    """Rejects secret that is too short."""
    monkeypatch.setenv("JWT_SECRET", "short")
    with pytest.raises(ConfigurationError) as exc_info:
        get_jwt_secret()
    assert "insecure" in str(exc_info.value).lower()
    assert "short" not in str(exc_info.value)

def test_valid_jwt_secret_accepted(monkeypatch):
    """Accepts valid strong secret."""
    monkeypatch.setenv("JWT_SECRET", "valid_secure_secret_12345")
    secret = get_jwt_secret()
    assert secret == "valid_secure_secret_12345"

def test_module_reload_fails_without_jwt_secret(monkeypatch):
    """Application initialization raises a runtime configuration error when JWT_SECRET is unset."""
    monkeypatch.delenv("JWT_SECRET", raising=False)
    from app import auth
    with pytest.raises(RuntimeError):
        importlib.reload(auth)
