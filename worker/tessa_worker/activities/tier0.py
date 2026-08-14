import uuid

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow, ScenarioRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.schemas.steps import Tier0Result
from tessa_api.schemas.temporal import RUN_TIER0_CHECKS_ACTIVITY, RunTier0ChecksInput
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.common import Tier0MismatchError
from tessa_worker.checks.contracts import StepExpectations
from tessa_worker.checks.internal_ids import build_tier0_context
from tessa_worker.checks.tier0 import evaluate_tier0


def permanent(message: str) -> ApplicationError:
    return ApplicationError(message, non_retryable=True)


def record_from_row(row: StepRow) -> StepRecord:
    if row.request is None:
        raise permanent(f"step {row.id} has no stored request, its payload was purged")
    try:
        return StepRecord.model_validate(
            {
                "adapter": row.adapter,
                "label": row.label,
                "request": row.request,
                "response": row.response,
                "response_truncated": row.response_truncated,
                "ok": row.ok,
                "ask": row.ask,
                "answer": row.answer,
                "tools": row.tools,
                "cards": row.cards,
                "latency_ms": row.latency_ms,
                "cost_usd": float(row.cost_usd),
                "started_at": row.started_at,
                "finished_at": row.finished_at,
            }
        )
    except ValidationError as error:
        raise permanent(
            f"step {row.id} does not hold a valid record: {error.error_count()} errors"
        ) from None


def expectations_of(document: ScenarioDoc, row: StepRow) -> StepExpectations:
    if row.index >= len(document.steps):
        raise permanent(f"step {row.id} has index {row.index}, the scenario has fewer steps")
    return document.steps[row.index].expect


async def required[Row](
    session: AsyncSession, model: type[Row], key: uuid.UUID | None, what: str
) -> Row:
    found = await session.get(model, key) if key is not None else None
    if found is None:
        raise permanent(f"{what} {key} does not exist")
    return found


async def evaluate_stored_step(session: AsyncSession, step_id: uuid.UUID) -> Tier0Result:
    row = await required(session, StepRow, step_id, "step")
    run_scenario = await required(session, RunScenarioRow, row.run_scenario_id, "run scenario")
    scenario = await required(session, ScenarioRow, run_scenario.scenario_id, "scenario")
    run = await required(session, RunRow, row.run_id, "run")
    bundle = await required(session, BundleRow, run.bundle_id or scenario.bundle_id, "bundle")
    if bundle.manifest is None:
        raise permanent(f"bundle {bundle.id} has no manifest")
    try:
        document = ScenarioDoc.model_validate(scenario.parsed)
        context = build_tier0_context(BundleManifest.model_validate(bundle.manifest))
    except ValidationError as error:
        problems = error.error_count()
        raise permanent(
            f"scenario {scenario.id} or its bundle no longer validates: {problems} errors"
        ) from None
    try:
        return evaluate_tier0(record_from_row(row), expectations_of(document, row), context)
    except Tier0MismatchError as error:
        raise permanent(str(error)) from None


class Tier0Activities:
    def __init__(self, session_factory: SessionFactory) -> None:
        self.session_factory = session_factory

    @activity.defn(name=RUN_TIER0_CHECKS_ACTIVITY)
    async def run_tier0_checks(self, request: RunTier0ChecksInput) -> Tier0Result:
        async with self.session_factory() as session:
            return await evaluate_stored_step(session, request.step_id)
