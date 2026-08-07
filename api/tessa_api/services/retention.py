import logging
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import AppSetting
from tessa_api.schemas.enums import AuditAction, AuditSubjectType
from tessa_api.schemas.retention import (
    RETENTION_MAX_DAYS,
    RetentionCutoffs,
    RetentionPolicy,
    RetentionState,
    RetentionSweepCounts,
    RetentionSweepResult,
)
from tessa_api.services.audit import record_audit
from tessa_api.services.settings_service import upsert_setting
from tessa_api.settings import StrictSettings

logger = logging.getLogger("tessa_api.retention")

RETENTION_POLICY_KEY = "retention"
RETENTION_LAST_SWEEP_KEY = "retention_last_sweep"


def clamped_days(days: int) -> int:
    return min(days, RETENTION_MAX_DAYS)


def default_policy(settings: StrictSettings) -> RetentionPolicy:
    return RetentionPolicy(
        steps_days=clamped_days(settings.retention_steps_days),
        artifacts_days=clamped_days(settings.artifact_retention_days),
        run_events_days=clamped_days(settings.retention_run_events_days),
    )


def retention_cutoffs(policy: RetentionPolicy, now: datetime) -> RetentionCutoffs:
    return RetentionCutoffs(
        steps_before=now - timedelta(days=policy.steps_days),
        artifacts_before=now - timedelta(days=policy.artifacts_days),
        run_events_before=now - timedelta(days=policy.run_events_days),
    )


async def stored_value(session: AsyncSession, key: str) -> Any | None:
    return await session.scalar(
        select(AppSetting.value).where(AppSetting.key == key, AppSetting.is_secret.is_(False))
    )


async def load_policy(session: AsyncSession, settings: StrictSettings) -> RetentionPolicy:
    stored = await stored_value(session, RETENTION_POLICY_KEY)
    if stored is None:
        return default_policy(settings)
    try:
        return RetentionPolicy.model_validate(stored)
    except ValidationError:
        logger.warning("retention_policy_ignored")
        return default_policy(settings)


async def load_last_sweep(session: AsyncSession) -> RetentionSweepResult | None:
    stored = await stored_value(session, RETENTION_LAST_SWEEP_KEY)
    if stored is None:
        return None
    try:
        return RetentionSweepResult.model_validate(stored)
    except ValidationError:
        logger.warning("retention_last_sweep_ignored")
        return None


async def read_retention_state(session: AsyncSession, settings: StrictSettings) -> RetentionState:
    return RetentionState(
        policy=await load_policy(session, settings), last_sweep=await load_last_sweep(session)
    )


async def apply_retention_policy(
    session: AsyncSession, settings: StrictSettings, user_id: UUID, policy: RetentionPolicy
) -> RetentionPolicy:
    before = await load_policy(session, settings)
    await session.execute(
        upsert_setting(RETENTION_POLICY_KEY, policy.model_dump(mode="json"), user_id)
    )
    if policy != before:
        await record_audit(
            session,
            user_id,
            AuditAction.retention_policy_changed,
            AuditSubjectType.retention,
            None,
            {"before": before.model_dump(mode="json"), "after": policy.model_dump(mode="json")},
        )
    return policy


async def record_sweep(
    session: AsyncSession, counts: RetentionSweepCounts, finished_at: datetime
) -> RetentionSweepResult:
    result = RetentionSweepResult(
        deleted_steps=counts.deleted_steps,
        deleted_artifacts=counts.deleted_artifacts,
        deleted_events=counts.deleted_events,
        at=finished_at,
    )
    await session.execute(
        upsert_setting(RETENTION_LAST_SWEEP_KEY, result.model_dump(mode="json"), None)
    )
    return result
