import os
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app import database, models, schemas

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass


class ConfigurationError(RuntimeError, ValueError):
    """Raised when application configuration is missing or insecure."""

    pass


INSECURE_SECRETS = {
    "dev_secret_key",
    "secret",
    "password",
    "changeme",
    "replace-me",
    "replace-with-strong-random",
}
MIN_SECRET_LENGTH = 8


def get_jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET")
    if secret is None or not secret.strip():
        raise ConfigurationError("JWT_SECRET environment variable is missing or blank.")
    secret = secret.strip()
    if secret in INSECURE_SECRETS or len(secret) < MIN_SECRET_LENGTH:
        raise ConfigurationError(
            "JWT_SECRET environment variable is insecure. "
            "Please provide a strong, unpredictable secret."
        )
    return secret


SECRET_KEY = get_jwt_secret()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

pwd_context = CryptContext(schemes=["bcrypt"], deprecated=["auto"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bool(pwd_context.verify(plain_password, hashed_password))


def get_password_hash(password: str) -> str:
    return str(pwd_context.hash(password))


def authenticate_user(
    db: Session, username: str, password: str
) -> models.User | Literal[False]:
    try:
        user = db.query(models.User).filter(models.User.username == username).first()
        if not user:
            return False
        hashed_password = user.hashed_password
        db.expunge(user)
    finally:
        db.close()

    if not verify_password(password, hashed_password):
        return False
    return user


def create_access_token(
    data: dict[str, Any], expires_delta: timedelta | None = None
) -> str:
    to_encode = data.copy()
    expire = datetime.now(UTC) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    encoded_jwt: str = jwt.encode(to_encode, get_jwt_secret(), algorithm=ALGORITHM)
    return encoded_jwt


def get_current_user(
    request: Request,
    token: Annotated[str, Depends(oauth2_scheme)],
) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[ALGORITHM])
        username: str | None = payload.get("sub")
        if username is None:
            raise credentials_exception
        token_data = schemas.TokenData(username=username)
    except JWTError as err:
        raise credentials_exception from err

    with database.session_scope(request) as db:
        user = (
            db.query(models.User)
            .filter(models.User.username == token_data.username)
            .first()
        )
        if user is None:
            raise credentials_exception
        _ = (user.id, user.username, user.hashed_password, user.is_manager)
        db.expunge(user)
        return user
