from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import RunRow
from tessa_api.schemas.enums import RunStatus

RUN_NOT_FOUND = "run_not_found"
CONFIG_FROZEN = "config_frozen"
CONFIG_WRITABLE_STATUSES = frozenset({RunStatus.queued, RunStatus.planning, RunStatus.seeding})


async def lock_unfrozen_run(session: AsyncSession, run_id: UUID) -> RunRow:
    run = await session.get(RunRow, run_id, with_for_update=True)
    if run is None:
        raise ApplicationError(
            f"run {run_id} does not exist", type=RUN_NOT_FOUND, non_retryable=True
        )
    if run.status not in CONFIG_WRITABLE_STATUSES:
        raise ApplicationError(
            f"the config snapshot of run {run_id} is frozen once the run is {run.status.value}",
            type=CONFIG_FROZEN,
            non_retryable=True,
        )
    return run


def merge_into_config(run: RunRow, values: Mapping[str, Any]) -> None:
    run.config_snapshot = {**run.config_snapshot, **values}
