import base64
import hashlib
from uuid import UUID

CANARY_PREFIX = "TESSA-CANARY-"
CANARY_PLACEHOLDER = "<canary>"
CANARY_TOKEN_LENGTH = 8


def canary_for(run_id: UUID, family_id: str, ordinal: int) -> str:
    digest = hashlib.sha256(f"{run_id}:{family_id}:{ordinal}".encode()).digest()
    token = base64.b32encode(digest).decode("ascii")[:CANARY_TOKEN_LENGTH]
    return f"{CANARY_PREFIX}{token}"
