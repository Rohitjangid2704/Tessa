import base64
import hashlib
import secrets
from dataclasses import dataclass

TOKEN_PREFIX = "ipt_"
TOKEN_BODY_BYTES = 32
DISPLAY_PREFIX_LENGTH = 12


@dataclass(frozen=True, slots=True)
class MintedToken:
    secret: str
    token_hash: str
    prefix: str


def hash_token(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def is_personal_token(value: str) -> bool:
    return value.startswith(TOKEN_PREFIX)


def mint_token() -> MintedToken:
    body = base64.urlsafe_b64encode(secrets.token_bytes(TOKEN_BODY_BYTES)).decode("ascii")
    secret = f"{TOKEN_PREFIX}{body.rstrip('=')}"
    return MintedToken(
        secret=secret, token_hash=hash_token(secret), prefix=secret[:DISPLAY_PREFIX_LENGTH]
    )
