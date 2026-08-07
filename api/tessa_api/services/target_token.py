from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.base import new_target_token
from tessa_api.db.models import Target


@dataclass(frozen=True)
class TokenMatch:
    target: Target
    matched_previous: bool


async def unused_token(session: AsyncSession) -> str:
    while True:
        candidate = new_target_token()
        taken = await session.scalar(
            select(Target.id).where(
                or_(Target.target_token == candidate, Target.previous_target_token == candidate)
            )
        )
        if taken is None:
            return candidate


async def rotate_token(session: AsyncSession, target: Target) -> None:
    replacement = await unused_token(session)
    target.previous_target_token = target.target_token
    target.target_token = replacement
    await session.flush()


async def find_target_by_token(session: AsyncSession, token: str) -> TokenMatch | None:
    target = await session.scalar(
        select(Target).where(
            or_(Target.target_token == token, Target.previous_target_token == token)
        )
    )
    if target is None:
        return None
    return TokenMatch(target=target, matched_previous=target.target_token != token)
