import re
import time
import uuid
from datetime import UTC, datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tessa_api.auth.users import DuplicateEmailError, create_user
from tessa_api.db.base import new_target_token
from tessa_api.db.models import Target, User
from tessa_api.ids import new_id
from tessa_api.schemas.common import format_timestamp
from tessa_api.schemas.enums import AppKind, TargetTier, UserRole
from tests.support import MakeUser

TARGET_TOKEN_PATTERN = re.compile(r"^tgt_[a-z2-7]{22}$")


def test_new_id_is_a_time_ordered_uuid7() -> None:
    identifiers = []
    for _ in range(5):
        identifiers.append(new_id())
        time.sleep(0.002)
    assert all(isinstance(identifier, uuid.UUID) for identifier in identifiers)
    assert all(identifier.version == 7 for identifier in identifiers)
    assert identifiers == sorted(identifiers)


def test_target_token_shape_and_uniqueness() -> None:
    tokens = {new_target_token() for _ in range(200)}
    assert len(tokens) == 200
    assert all(TARGET_TOKEN_PATTERN.match(token) for token in tokens)


def test_timestamps_serialize_with_milliseconds_and_z() -> None:
    moment = datetime(2026, 9, 30, 14, 3, 22, 123456, tzinfo=UTC)
    assert format_timestamp(moment) == "2026-09-30T14:03:22.123Z"
    offset = datetime(2026, 9, 30, 16, 3, 22, 5000, tzinfo=timezone(timedelta(hours=2)))
    assert format_timestamp(offset) == "2026-09-30T14:03:22.005Z"


@pytest.mark.integration
async def test_user_email_is_unique_case_insensitively(
    db_app: FastAPI, make_user: MakeUser
) -> None:
    await make_user(email="Same@tessa.test")
    async with db_app.state.session_factory() as session:
        with pytest.raises(DuplicateEmailError):
            await create_user(
                session, "SAME@tessa.test", "Dup", "dev-only-password-1", UserRole.member
            )


@pytest.mark.integration
async def test_role_check_constraint_rejects_unknown_roles(
    db_app: FastAPI, make_user: MakeUser
) -> None:
    user = await make_user()
    async with db_app.state.session_factory() as session:
        with pytest.raises(IntegrityError):
            await session.execute(
                text("UPDATE users SET role = 'owner' WHERE id = :id"), {"id": user.id}
            )


@pytest.mark.integration
async def test_target_defaults_and_tier_check(db_app: FastAPI, make_user: MakeUser) -> None:
    owner = await make_user()
    async with db_app.state.session_factory() as session:
        target = Target(
            name="Gracie",
            slug="gracie",
            app_kind=AppKind.llm_assistant,
            created_by=owner.id,
        )
        session.add(target)
        await session.commit()
        await session.refresh(target)
        assert target.tier is TargetTier.qa
        assert target.allow_production is False
        assert target.hints == {}
        assert TARGET_TOKEN_PATTERN.match(target.target_token)
        assert target.archived_at is None
        with pytest.raises(IntegrityError):
            await session.execute(text("UPDATE targets SET tier = 'staging'"))


@pytest.mark.integration
async def test_user_enum_round_trips_as_text(db_app: FastAPI, make_user: MakeUser) -> None:
    user = await make_user(UserRole.viewer)
    async with db_app.state.session_factory() as session:
        stored = await session.scalar(text("SELECT role FROM users"))
        loaded = await session.get(User, user.id)
    assert stored == "viewer"
    assert loaded is not None
    assert loaded.role is UserRole.viewer
