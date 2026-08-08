from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.exc import InterfaceError, OperationalError

from tessa_api.db.session import SessionFactory
from tessa_api.errors import ApiError
from tessa_api.services.personal_tokens import authenticate_personal_token


class StreamGuard(Protocol):
    async def __call__(self) -> bool: ...


@dataclass(frozen=True, slots=True)
class PersonalTokenGuard:
    session_factory: SessionFactory
    secret: str

    async def __call__(self) -> bool:
        try:
            async with self.session_factory() as session:
                await authenticate_personal_token(session, self.secret, touch=False)
        except ApiError:
            return False
        except (OperationalError, InterfaceError, ConnectionError):
            return True
        return True
