import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

from tessa_api.errors import unauthenticated
from tessa_api.ids import new_id
from tessa_api.schemas.enums import UserRole
from tessa_api.settings import Settings

ALGORITHM = "HS256"
REQUIRED_CLAIMS = ["exp", "iss", "aud", "sub", "iat"]
LEEWAY_SECONDS = 5
DEFAULT_TTL_SECONDS = 300


@dataclass(frozen=True)
class TokenClaims:
    user_id: uuid.UUID
    token_id: str | None


def decode_api_token(token: str, settings: Settings) -> TokenClaims:
    try:
        claims = jwt.decode(
            token,
            settings.api_jwt_secret.get_secret_value(),
            algorithms=[ALGORITHM],
            audience=settings.api_jwt_audience,
            issuer=settings.api_jwt_issuer,
            options={"require": REQUIRED_CLAIMS},
            leeway=LEEWAY_SECONDS,
        )
    except jwt.ExpiredSignatureError:
        raise unauthenticated("Token expired", code="token_expired") from None
    except jwt.InvalidTokenError:
        raise unauthenticated("Invalid token") from None
    try:
        user_id = uuid.UUID(claims["sub"])
    except ValueError:
        raise unauthenticated("Invalid token subject") from None
    return TokenClaims(user_id=user_id, token_id=claims.get("jti"))


def encode_api_token(
    settings: Settings,
    user_id: uuid.UUID,
    email: str,
    role: UserRole,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    issued_at: datetime | None = None,
) -> str:
    moment = issued_at or datetime.now(UTC)
    claims = {
        "iss": settings.api_jwt_issuer,
        "aud": settings.api_jwt_audience,
        "sub": str(user_id),
        "email": email,
        "role": role.value,
        "iat": int(moment.timestamp()),
        "exp": int((moment + timedelta(seconds=ttl_seconds)).timestamp()),
        "jti": str(new_id()),
    }
    return jwt.encode(
        claims,
        settings.api_jwt_secret.get_secret_value(),
        algorithm=ALGORITHM,
        headers={"typ": "JWT"},
    )
