import uuid

from pydantic import ValidationError
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow, ScenarioRow, StepRow
from tessa_api.schemas.bundle import BundleManifest, Invariant
from tessa_api.schemas.grading import EvidenceBlock
from tessa_api.schemas.oracles import GoldPoint
from tessa_worker.grading.errors import GradingErrorType, permanent_error
from tessa_worker.grading.evidence import EvidenceSource, build_evidence

JUDGEABLE_INVARIANT_CHECKS = frozenset({"probe", "oracle"})


def parse_gold_points(step: StepRow) -> list[GoldPoint]:
    try:
        return [GoldPoint.model_validate(entry) for entry in step.gold_points]
    except ValidationError:
        raise permanent_error(
            GradingErrorType.evidence_invalid, f"step {step.id} holds invalid gold points"
        ) from None


def judgeable_invariants(manifest: BundleManifest, feature_id: str | None) -> list[Invariant]:
    if feature_id is None:
        return []
    feature = next((item for item in manifest.features if item.id == feature_id), None)
    if feature is None:
        return []
    wanted = set(feature.invariants)
    return [
        invariant
        for invariant in manifest.invariants
        if invariant.id in wanted and invariant.check in JUDGEABLE_INVARIANT_CHECKS
    ]


async def load_feature_invariants(session: AsyncSession, step: StepRow) -> list[Invariant]:
    run_scenario = await session.get(RunScenarioRow, step.run_scenario_id)
    run = await session.get(RunRow, step.run_id)
    if run_scenario is None or run is None:
        return []
    scenario = await session.get(ScenarioRow, run_scenario.scenario_id)
    bundle_id = run.bundle_id or (scenario.bundle_id if scenario is not None else None)
    bundle = await session.get(BundleRow, bundle_id) if bundle_id is not None else None
    if scenario is None or bundle is None or bundle.manifest is None:
        return []
    try:
        manifest = BundleManifest.model_validate(bundle.manifest)
    except ValidationError:
        return []
    return judgeable_invariants(manifest, scenario.feature_id)


async def load_step(session: AsyncSession, step_id: uuid.UUID) -> StepRow:
    step = await session.get(StepRow, step_id)
    if step is None:
        raise permanent_error(GradingErrorType.step_not_found, f"step {step_id} does not exist")
    return step


async def load_evidence_source(
    session: AsyncSession,
    step_id: uuid.UUID,
    must_not_claim: tuple[str, ...] = (),
) -> EvidenceSource:
    step = await load_step(session, step_id)
    return EvidenceSource(
        ask=step.ask,
        answer=step.answer,
        gold_points=parse_gold_points(step),
        must_not_claim=must_not_claim,
        invariants=await load_feature_invariants(session, step),
    )


async def store_evidence(
    session: AsyncSession, step_id: uuid.UUID, evidence: EvidenceBlock
) -> None:
    await session.execute(
        update(StepRow)
        .where(StepRow.id == step_id)
        .values(evidence=evidence.model_dump(mode="json"))
    )


async def build_and_store_evidence(
    session: AsyncSession, step_id: uuid.UUID, must_not_claim: tuple[str, ...] = ()
) -> EvidenceBlock:
    source = await load_evidence_source(session, step_id, must_not_claim)
    evidence = build_evidence(source)
    await store_evidence(session, step_id, evidence)
    await session.commit()
    return evidence
