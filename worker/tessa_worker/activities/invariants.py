import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass

from pydantic import ValidationError
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity

from tessa_api.db.models import (
    BundleRow,
    InvariantResultRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
)
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest, Feature
from tessa_api.schemas.enums import SyntheticFamily, VerdictStatus, VerdictTier
from tessa_api.schemas.temporal import (
    EVALUATE_INVARIANTS_ACTIVITY,
    INVARIANTS_START_TO_CLOSE,
    EvaluateInvariantsInput,
    InvariantResultBatch,
)
from tessa_api.services.invariants.selection import (
    AppliedInvariant,
    SelectionContext,
    applicable_invariants,
)
from tessa_api.services.settings_service import effective_settings
from tessa_worker.activities.grading import probe_polarity
from tessa_worker.activities.tier0 import permanent, required
from tessa_worker.checks.internal_ids import build_tier0_context
from tessa_worker.event_client import EventClient
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantEvaluator,
    InvariantOutcome,
    ProbeRunner,
)
from tessa_worker.invariants.loading import load_invariant_steps
from tessa_worker.invariants.probe_runner import StepProbeRunner
from tessa_worker.invariants.registry import evaluator_for
from tessa_worker.invariants.results import new_result_row, result_event, to_invariant_result
from tessa_worker.invariants.rollup import severity_rank
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.invariants")

EVALUATION_MARGIN_SECONDS = 15.0
EVALUATOR_TIMEOUT_SECONDS = INVARIANTS_START_TO_CLOSE.total_seconds() - EVALUATION_MARGIN_SECONDS
MAX_RESULTS_PER_INVARIANT = 20
INVARIANT_ID_KEY = "invariant_id"
SYNTHETIC_FAMILY = SyntheticFamily.invariant.value


@dataclass(frozen=True, slots=True)
class EvaluationMaterial:
    context: InvariantContext
    applied: list[AppliedInvariant]


def manifest_of(bundle: BundleRow) -> BundleManifest:
    try:
        return BundleManifest.model_validate(bundle.manifest)
    except ValidationError:
        raise permanent(f"bundle {bundle.id} has no valid manifest") from None


def feature_of(manifest: BundleManifest, feature_id: str | None) -> Feature | None:
    return next((item for item in manifest.features if item.id == feature_id), None)


def active_invariant_id(scenario: ScenarioRow) -> str | None:
    if scenario.family != SYNTHETIC_FAMILY or scenario.parsed.get("synthetic") is not True:
        return None
    declared = (scenario.provenance or {}).get(INVARIANT_ID_KEY)
    if not isinstance(declared, str) or not declared:
        raise permanent(f"synthetic scenario {scenario.id} does not name its invariant")
    return declared


def failure_outcome(evaluator: InvariantEvaluator, message: str) -> InvariantOutcome:
    return InvariantOutcome(
        invariant_id=evaluator.invariant_id,
        pack=evaluator.pack,
        status=VerdictStatus.uncertain,
        tier=VerdictTier.code,
        confidence=None,
        message=message,
        skip_reason=None,
        step_id=None,
        signal=None,
    )


async def run_evaluator(
    evaluator: InvariantEvaluator, context: InvariantContext, probes: ProbeRunner
) -> list[InvariantOutcome]:
    try:
        async with asyncio.timeout(EVALUATOR_TIMEOUT_SECONDS):
            outcomes = list(await evaluator.evaluate(context, probes))
    except TimeoutError:
        return [
            failure_outcome(
                evaluator,
                f"the check did not finish within {EVALUATOR_TIMEOUT_SECONDS:g} seconds",
            )
        ]
    except Exception as error:
        logger.warning(
            "invariant_evaluator_failed",
            extra={"invariant_id": evaluator.invariant_id, "error": type(error).__name__},
        )
        return [failure_outcome(evaluator, f"the check failed with {type(error).__name__}")]
    return outcomes or [failure_outcome(evaluator, "the check returned no result")]


def result_rows(
    request: EvaluateInvariantsInput,
    evaluated: Sequence[tuple[InvariantEvaluator, list[InvariantOutcome]]],
) -> list[InvariantResultRow]:
    rows: list[InvariantResultRow] = []
    for evaluator, outcomes in evaluated:
        kept = sorted(outcomes, key=lambda outcome: severity_rank(outcome.status))
        rows.extend(
            new_result_row(
                run_id=request.run_id,
                run_scenario_id=request.run_scenario_id,
                step_id=outcome.step_id,
                attempt=request.attempt,
                invariant_id=evaluator.invariant_id,
                pack=outcome.pack,
                status=outcome.status,
                tier=outcome.tier,
                confidence=outcome.confidence,
                message=outcome.message,
                skip_reason=outcome.skip_reason,
                ordinal=ordinal,
            )
            for ordinal, outcome in enumerate(kept[:MAX_RESULTS_PER_INVARIANT])
        )
    return rows


class InvariantActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        probes: ProbeRunner,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self.probes = probes

    @activity.defn(name=EVALUATE_INVARIANTS_ACTIVITY)
    async def evaluate_invariants(self, request: EvaluateInvariantsInput) -> InvariantResultBatch:
        async with self.session_factory() as session:
            material = await self.load_material(session, request)
        probes = StepProbeRunner(self.probes, self.session_factory)
        evaluated = await asyncio.gather(
            *(self.evaluate_one(applied, material.context, probes) for applied in material.applied)
        )
        rows = result_rows(request, evaluated)
        await self.replace_results(request, rows)
        await self.events.deliver_all([result_event(row) for row in rows])
        return InvariantResultBatch(results=[to_invariant_result(row) for row in rows])

    async def evaluate_one(
        self, applied: AppliedInvariant, context: InvariantContext, probes: ProbeRunner
    ) -> tuple[InvariantEvaluator, list[InvariantOutcome]]:
        evaluator = evaluator_for(applied)
        scoped = context.model_copy(update={"params": applied.params})
        return evaluator, await run_evaluator(evaluator, scoped, probes)

    async def load_material(
        self, session: AsyncSession, request: EvaluateInvariantsInput
    ) -> EvaluationMaterial:
        run_scenario = await required(
            session, RunScenarioRow, request.run_scenario_id, "run scenario"
        )
        if run_scenario.run_id != request.run_id:
            raise permanent(
                f"run scenario {run_scenario.id} does not belong to run {request.run_id}"
            )
        scenario = await required(session, ScenarioRow, run_scenario.scenario_id, "scenario")
        run = await required(session, RunRow, request.run_id, "run")
        bundle = await required(session, BundleRow, run.bundle_id or scenario.bundle_id, "bundle")
        manifest = manifest_of(bundle)
        effective = await effective_settings(session, self.settings)
        steps = await load_invariant_steps(session, run_scenario.id, request.attempt)
        context = InvariantContext(
            run_id=run.id,
            run_scenario_id=run_scenario.id,
            scenario_id=scenario.id,
            attempt=request.attempt,
            feature_id=scenario.feature_id,
            family=scenario.family,
            role=run_scenario.role,
            interface_id=run_scenario.interface_id,
            app_kind=manifest.app.kind,
            read_only=run.read_only,
            steps=steps,
            params={},
            latency_default_ms=effective.invariant_latency_ms,
            internal_id_patterns=build_tier0_context(manifest).internal_id_patterns,
            probe_polarity=probe_polarity(effective, manifest),
        )
        return EvaluationMaterial(context, self.applicable(request, manifest, scenario, context))

    def applicable(
        self,
        request: EvaluateInvariantsInput,
        manifest: BundleManifest,
        scenario: ScenarioRow,
        context: InvariantContext,
    ) -> list[AppliedInvariant]:
        adapters = frozenset(step.adapter for step in context.steps) or frozenset(
            interface.kind
            for interface in manifest.interfaces
            if interface.id == context.interface_id
        )
        selected = applicable_invariants(
            SelectionContext(
                app_kind=manifest.app.kind,
                feature=feature_of(manifest, scenario.feature_id),
                bundle_invariants={invariant.id: invariant for invariant in manifest.invariants},
                adapters=adapters,
                active_invariant_id=active_invariant_id(scenario),
            )
        )
        return [item for item in selected if not request.pack_ids or item.pack in request.pack_ids]

    async def replace_results(
        self, request: EvaluateInvariantsInput, rows: Sequence[InvariantResultRow]
    ) -> None:
        async with self.session_factory() as session:
            await session.execute(
                delete(InvariantResultRow).where(
                    InvariantResultRow.run_scenario_id == request.run_scenario_id,
                    InvariantResultRow.attempt.is_not_distinct_from(request.attempt),
                )
            )
            session.add_all(rows)
            await session.commit()
