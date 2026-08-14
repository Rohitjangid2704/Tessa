import logging
from collections.abc import Mapping
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity

from tessa_api.db.models import RunRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.common import Budget
from tessa_api.schemas.enums import ModelRole, ProbeAnswerType, SecretName
from tessa_api.schemas.grading import GradePolicy, ModelCallSpec
from tessa_api.schemas.runs import ModelSnapshot, RunConfigSnapshot
from tessa_api.schemas.steps import Tier0Result
from tessa_api.schemas.streams import StepGradedPayload
from tessa_api.services.grading_rules import MachineGrading
from tessa_api.services.probe_bank import NO_ANSWER, YES_ANSWER, ProbeBankError, load_probe_bank
from tessa_api.services.probe_specs import ProbeSpec, listed_specs
from tessa_api.services.settings_service import (
    effective_settings,
    model_call_spec,
    resolve_secret,
    resolve_thresholds,
)
from tessa_api.services.step_overlay import (
    STEP_GRADED_EVENT,
    latest_human_step_label,
    lock_step,
    standing_of,
    verdict_json,
)
from tessa_api.services.vault import Vault
from tessa_worker.activities.grading_models import (
    LIST_ATTEMPT_STEPS,
    LOAD_STEP_GRADING,
    RECORD_STEP_GRADE,
    RESOLVE_GRADE_POLICY,
    DecidedStep,
    ListAttemptStepsInput,
    ListAttemptStepsResult,
    LoadStepGradingInput,
    ProbePolarity,
    RecordStepGradeInput,
    RecordStepGradeResult,
    StepGradingContext,
)
from tessa_worker.activities.probes import load_step_material
from tessa_worker.activities.tier0 import permanent, required
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.grading")


def allowed_answers_of(spec: ProbeSpec) -> list[str]:
    if spec.answer_type is ProbeAnswerType.yes_no:
        return [YES_ANSWER, NO_ANSWER]
    return list(spec.choices)


def probe_polarity(
    settings: WorkerSettings, manifest: BundleManifest | None
) -> dict[str, ProbePolarity]:
    try:
        bank = load_probe_bank(settings.probes_dir)
    except ProbeBankError as error:
        logger.warning("probe_polarity_unavailable", extra={"reason": str(error)[:200]})
        return {}
    return {
        spec.id: ProbePolarity(
            compliant_answer=spec.compliant_choice, allowed_answers=allowed_answers_of(spec)
        )
        for spec in listed_specs(bank, manifest)
    }


def snapshot_models_of(run: RunRow) -> Mapping[ModelRole, ModelSnapshot]:
    try:
        return RunConfigSnapshot.model_validate(run.config_snapshot).models or {}
    except ValidationError:
        return {}


def pinned_spec(
    role: ModelRole, settings: WorkerSettings, snapshot: Mapping[ModelRole, ModelSnapshot]
) -> ModelCallSpec:
    spec = model_call_spec(role, settings)
    pinned = snapshot.get(role)
    if pinned is None:
        return spec
    return spec.model_copy(update={"model": pinned.model, "effort": pinned.effort})


def remaining_budget_usd(run: RunRow) -> float:
    budget = Budget.model_validate(run.budget)
    return max(0.0, budget.max_usd - float(run.spent_usd))


def stored_tier0(step: StepRow) -> Tier0Result | None:
    try:
        return Tier0Result.model_validate(step.tier0)
    except ValidationError:
        return None


async def step_of_run(session: AsyncSession, step_id: UUID, run_id: UUID) -> StepRow:
    step = await required(session, StepRow, step_id, "step")
    if step.run_id != run_id:
        raise permanent(f"step {step_id} does not belong to run {run_id}")
    return step


class GradingActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        vault: Vault,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self.vault = vault

    @activity.defn(name=LOAD_STEP_GRADING)
    async def load_step_grading(self, request: LoadStepGradingInput) -> StepGradingContext:
        async with self.session_factory() as session:
            effective = await effective_settings(session, self.settings)
            step = await step_of_run(session, request.step_id, request.run_id)
            run = await required(session, RunRow, request.run_id, "run")
            material = await load_step_material(session, request.step_id)
            snapshot = snapshot_models_of(run)
            return StepGradingContext(
                run_scenario_id=step.run_scenario_id,
                step_completed=step.ok is not False,
                tier0=stored_tier0(step),
                probe_polarity=probe_polarity(effective, material.manifest),
                judge_spec=pinned_spec(ModelRole.judge, effective, snapshot),
                tiebreak_spec=pinned_spec(ModelRole.judge_tiebreak, effective, snapshot),
                budget_remaining_usd=remaining_budget_usd(run),
            )

    @activity.defn(name=LIST_ATTEMPT_STEPS)
    async def list_attempt_steps(self, request: ListAttemptStepsInput) -> ListAttemptStepsResult:
        async with self.session_factory() as session:
            rows = await session.execute(
                select(StepRow.id, StepRow.machine_grading)
                .where(
                    StepRow.run_scenario_id == request.run_scenario_id,
                    StepRow.attempt == request.attempt,
                )
                .order_by(StepRow.index)
            )
            recorded = list(rows)
        return ListAttemptStepsResult(
            step_ids=[step_id for step_id, _ in recorded],
            decided=[
                DecidedStep(step_id=step_id, grading=MachineGrading.model_validate(raw))
                for step_id, raw in recorded
                if raw is not None
            ],
        )

    @activity.defn(name=RECORD_STEP_GRADE)
    async def record_step_grade(self, request: RecordStepGradeInput) -> RecordStepGradeResult:
        grading = MachineGrading(
            verdict=request.verdict,
            escalated_to=request.escalated_to,
            review_reasons=request.review_reasons,
        )
        async with self.session_factory() as session:
            step = await lock_step(session, request.step_id)
            if step is None or step.run_id != request.run_id:
                raise permanent(f"step {request.step_id} does not exist in run {request.run_id}")
            standing = standing_of(grading, await latest_human_step_label(session, step.id))
            step.machine_grading = grading.model_dump(mode="json")
            step.verdict = verdict_json(standing.verdict)
            run_scenario_id = step.run_scenario_id
            await session.commit()
        if standing.verdict is None:
            raise permanent(f"step {request.step_id} has no effective verdict")
        await self.events.deliver(
            [
                build_event(
                    request.run_id,
                    STEP_GRADED_EVENT,
                    StepGradedPayload(
                        step_id=request.step_id,
                        run_scenario_id=run_scenario_id,
                        verdict=standing.verdict,
                        escalated_to=standing.escalated_to,
                    ),
                    f"{STEP_GRADED_EVENT}:{request.step_id}",
                )
            ]
        )
        return RecordStepGradeResult(verdict=standing.verdict, escalated_to=standing.escalated_to)

    @activity.defn(name=RESOLVE_GRADE_POLICY)
    async def resolve_grade_policy(self) -> GradePolicy:
        async with self.session_factory() as session:
            effective = await effective_settings(session, self.settings)
            thresholds = await resolve_thresholds(session, self.settings)
            key = await resolve_secret(
                session, self.vault, self.settings, SecretName.anthropic_api_key
            )
        return GradePolicy(
            probe_confidence=thresholds.probe_confidence,
            judge_escalate_below=thresholds.judge_escalate_below,
            tiebreak_enabled=effective.stub_models or key is not None,
        )
