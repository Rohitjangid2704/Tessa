import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit
from uuid import UUID

import jwt

from tessa_api.ids import new_id
from tessa_api.schemas.streams import WsTicket
from tessa_api.settings import Settings

ALGORITHM = "HS256"
TICKET_TYPE = "ws-ticket"
REQUIRED_CLAIMS = ["exp", "iat", "sub", "run_id", "jti", "typ"]


class TicketError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class TicketClaims:
    user_id: UUID
    run_id: UUID
    token_id: str
    expires_at: int


def build_ws_url(public_api_url: str, run_id: UUID, ticket: str) -> str:
    parts = urlsplit(public_api_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    path = parts.path.rstrip("/")
    return f"{scheme}://{parts.netloc}{path}/ws/v1/runs/{run_id}?ticket={quote(ticket, safe='')}"


def issue_ticket(
    settings: Settings, user_id: UUID, run_id: UUID, issued_at: datetime | None = None
) -> WsTicket:
    moment = issued_at or datetime.now(UTC)
    issued = int(moment.timestamp())
    expires = issued + settings.ws_ticket_ttl_seconds
    token = jwt.encode(
        {
            "typ": TICKET_TYPE,
            "sub": str(user_id),
            "run_id": str(run_id),
            "jti": str(new_id()),
            "iat": issued,
            "exp": expires,
        },
        settings.signing_key.get_secret_value(),
        algorithm=ALGORITHM,
    )
    return WsTicket(
        ticket=token,
        ws_url=build_ws_url(settings.public_api_url, run_id, token),
        expires_at=datetime.fromtimestamp(expires, UTC),
    )


def verify_ticket(settings: Settings, token: str) -> TicketClaims:
    try:
        claims = jwt.decode(
            token,
            settings.signing_key.get_secret_value(),
            algorithms=[ALGORITHM],
            options={"require": REQUIRED_CLAIMS},
        )
    except jwt.ExpiredSignatureError:
        raise TicketError("ticket_expired") from None
    except jwt.InvalidTokenError:
        raise TicketError("ticket_invalid") from None
    if claims["typ"] != TICKET_TYPE:
        raise TicketError("ticket_invalid")
    try:
        return TicketClaims(
            user_id=UUID(claims["sub"]),
            run_id=UUID(claims["run_id"]),
            token_id=str(claims["jti"]),
            expires_at=int(claims["exp"]),
        )
    except (ValueError, TypeError, AttributeError):
        raise TicketError("ticket_invalid") from None


class TicketRegistry:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._used: dict[str, int] = {}

    def consume(self, token_id: str, expires_at: int) -> bool:
        now = self._clock()
        self._used = {key: expiry for key, expiry in self._used.items() if expiry > now}
        if token_id in self._used:
            return False
        self._used[token_id] = expires_at
        return True

    def remembered(self) -> int:
        return len(self._used)
