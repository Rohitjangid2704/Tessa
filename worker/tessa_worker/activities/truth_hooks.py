from typing import Any
from uuid import UUID

from pydantic import JsonValue, ValidationError
from sqlalchemy import ScalarResult, select

from tessa_api.db.models import StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import LabelReason, OracleResultStatus, VerdictStatus
from tessa_api.schemas.oracles import GoldPoint
from tessa_api.schemas.scenario import ScenarioStep
from tessa_api.schemas.steps import Tier0Failure, Tier0Result
from tessa_api.schemas.temporal import CheckDbExpectationInput
from tessa_api.services.gold_interpolation import UnknownGoldKeyError, gold_keys_in_value
from tessa_api.services.grading_rules import MachineGrading
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.drive_ports import PreparedStep, StepAssessment, StepContext
from tessa_worker.adapters.base import StepRecord
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.gold import gold_mapping, gold_text_failures, interpolate_step
from tessa_worker.truth.oracle_service import OracleService
from tessa_worker.truth.step_checks import StepChecks, StepScope, interpolated_expectation
from tessa_worker.truth.truth_verdicts import (
    OracleStanding,
    gold_unavailable_verdict,
    oracle_gate_verdict,
)

GOLD_POINTS_COLUMN = "gold_points"
VERDICT_COLUMN = "verdict"
MACHINE_GRADING_COLUMN = "machine_grading"
GOLD_ERROR_LIMIT = 300


def gold_references(step: ScenarioStep) -> list[str]:
    return gold_keys_in_value(step.model_dump(mode="json", by_alias=True, exclude_none=True))


def needs_truth_checks(step: ScenarioStep) -> bool:
    return step.gold_from is not None or step.expect_db is not None or bool(gold_references(step))


def decided_columns(verdict: Verdict) -> dict[str, JsonValue]:
    reasons = [LabelReason.uncertain] if verdict.status is VerdictStatus.uncertain else []
    grading = MachineGrading(verdict=verdict, escalated_to=None, review_reasons=reasons)
    return {
        VERDICT_COLUMN: verdict.model_dump(mode="json"),
        MACHINE_GRADING_COLUMN: grading.model_dump(mode="json"),
    }


class TruthStepHooks:
    def __init__(self, session_factory: SessionFactory, checks: StepChecks) -> None:
        self.session_factory = session_factory
        self.checks = checks

    async def before_step(self, context: StepContext) -> PreparedStep:
        step = context.step
        if not needs_truth_checks(step):
            return PreparedStep(step=step)
        scope = await self.checks.load_scope(context.run_id, context.run_scenario_id)
        gold: dict[str, GoldPoint] = {}
        if gold_references(step):
            gold = await self.attempt_gold(context.run_scenario_id, context.attempt, context.index)
        columns: dict[str, JsonValue] = {}
        if step.gold_from is not None:
            resolution = await self.checks.resolve_gold(scope, step.gold_from)
            if resolution.blocked is not None:
                return PreparedStep(step=step, halt=resolution.blocked)
            gold.update(gold_mapping(resolution.gold_points))
            stored_points: list[JsonValue] = [
                point.model_dump(mode="json") for point in resolution.gold_points
            ]
            columns[GOLD_POINTS_COLUMN] = stored_points
        if step.expect_db is not None:
            blocked = await self.unapproved_oracle(scope, step.expect_db.oracle)
            if blocked is not None:
                return PreparedStep(step=step, halt=blocked)
        try:
            interpolated = interpolate_step(step, gold).step
            if step.expect_db is not None:
                interpolated_expectation(step.expect_db.expect, gold)
        except (UnknownGoldKeyError, ValidationError) as error:
            reason = str(error)[:GOLD_ERROR_LIMIT]
            return PreparedStep(step=step, halt=gold_unavailable_verdict(reason))
        return PreparedStep(step=interpolated, step_columns=columns)

    async def after_step(
        self, context: StepContext, step_id: UUID, record: StepRecord, tier0: Tier0Result
    ) -> StepAssessment:
        step = context.step
        if not needs_truth_checks(step):
            return StepAssessment()
        failures: tuple[Tier0Failure, ...] = ()
        if gold_references(step):
            gold = await self.attempt_gold(
                context.run_scenario_id, context.attempt, context.index + 1
            )
            try:
                texts = interpolate_step(step, gold).gold_answer_texts
            except (UnknownGoldKeyError, ValidationError) as error:
                return self.assessment(gold_unavailable_verdict(str(error)[:GOLD_ERROR_LIMIT]), ())
            failures = tuple(gold_text_failures(record.answer, texts))
        verdict: Verdict | None = None
        if step.expect_db is not None and record.ok is not False:
            outcome = await self.checks.check_db_for_step(CheckDbExpectationInput(step_id=step_id))
            verdict = outcome.verdict
        return self.assessment(verdict, failures)

    def assessment(
        self, verdict: Verdict | None, failures: tuple[Tier0Failure, ...]
    ) -> StepAssessment:
        if verdict is None or verdict.status is VerdictStatus.pass_:
            return StepAssessment(verdict=verdict, failures=failures)
        return StepAssessment(
            verdict=verdict, failures=failures, step_columns=decided_columns(verdict)
        )

    async def attempt_gold(
        self, run_scenario_id: UUID, attempt: int, before_index: int
    ) -> dict[str, GoldPoint]:
        async with self.session_factory() as session:
            stored: ScalarResult[list[dict[str, Any]]] = await session.scalars(
                select(StepRow.gold_points)
                .where(
                    StepRow.run_scenario_id == run_scenario_id,
                    StepRow.attempt == attempt,
                    StepRow.index < before_index,
                )
                .order_by(StepRow.index)
            )
            return gold_mapping(
                GoldPoint.model_validate(point) for points in stored for point in points
            )

    async def unapproved_oracle(self, scope: StepScope, name: str) -> Verdict | None:
        template = await self.checks.template_for(scope, name)
        approval = None if template is None else template.approval
        return oracle_gate_verdict(OracleStanding(name, approval, OracleResultStatus.ok))


def default_truth_hooks(
    settings: WorkerSettings, session_factory: SessionFactory
) -> TruthStepHooks:
    oracles = OracleService(session_factory, vault_from_settings(settings), settings)
    return TruthStepHooks(session_factory, StepChecks(session_factory, oracles))
