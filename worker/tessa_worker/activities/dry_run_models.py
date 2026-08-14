from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field
from temporalio.exceptions import ApplicationError

from tessa_api.schemas.common import Budget

LOAD_DRY_RUN_CONTEXT = "load_dry_run_context"
PREPARE_DRY_RUN = "prepare_dry_run"
SKIP_DRY_RUN = "skip_dry_run"

PreparedOutcome = Literal["ready", "ineligible"]


class DryRunErrorType(StrEnum):
    scenario_not_found = "scenario_not_found"
    run_not_found = "run_not_found"


def permanent_dry_run_error(kind: DryRunErrorType, message: str) -> ApplicationError:
    return ApplicationError(message, type=kind.value, non_retryable=True)


class LoadDryRunContextInput(BaseModel):
    run_id: UUID


class DryRunContext(BaseModel):
    dry_run_repeats: int = Field(ge=1, description="TESSA_DRY_RUN_REPEATS")
    dry_run_concurrency: int = Field(
        ge=1, description="dry runs executing at once, the effective run concurrency"
    )
    budget: Budget


class PrepareDryRunInput(BaseModel):
    run_id: UUID
    scenario_id: UUID
    repeats: int = Field(ge=1)


class PreparedDryRun(BaseModel):
    outcome: PreparedOutcome
    run_scenario_id: UUID | None
    attempts: int = Field(ge=1)
    timeout_seconds: int = Field(ge=1)
    detail: str | None


class SkipDryRunInput(BaseModel):
    run_id: UUID
    scenario_id: UUID
    reason: str = Field(min_length=1, max_length=300)


class SkipDryRunResult(BaseModel):
    scenario_id: UUID
