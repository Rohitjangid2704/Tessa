import logging
import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import AttackRow, BundleRow, FindingRow, RunRow
from tessa_api.schemas.attack_family import FamilyDefinition
from tessa_api.schemas.enums import SyntheticFamily
from tessa_api.schemas.streams import IngestEvent
from tessa_api.schemas.temporal import DedupeMatch, UpsertDecision
from tessa_api.services.findings.repro import ReproUnavailableError, store_repro
from tessa_api.services.findings.upsert import upsert_decisions
from tessa_api.services.grading_rules import clip_text, redacted_text
from tessa_api.services.redteam_channel import (
    AttackChannel,
    attack_channel,
    attack_scenario_document,
    attack_scenario_key,
)
from tessa_api.services.redteam_findings import ConfirmedAttack, confirmed_attack_candidate
from tessa_api.services.synthetic_scenarios import (
    SyntheticScenario,
    SyntheticScenarioRequest,
    create_synthetic_run_scenario,
    queued_payload,
)
from tessa_worker.activities.redteam_models import (
    AssessAttackInput,
    AttackAssessment,
    PrepareAttackInput,
    PrepareAttackReplaysInput,
    PreparedAttack,
    PreparedReplays,
    SettleAttackInput,
)
from tessa_worker.event_client import build_event
from tessa_worker.lab.redteam.canary import CANARY_PLACEHOLDER
from tessa_worker.lab.redteam.context import ensure_attack_ready, manifest_of
from tessa_worker.lab.redteam.errors import RedTeamErrorType, permanent_redteam_error
from tessa_worker.lab.redteam.families import family_of
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.lab.redteam")

ATTACK_NAMESPACE = uuid.UUID("b2a64e90-1f7c-45d3-8e02-6c9d0a5f7e13")
EXCERPT_LIMIT = 500
SCENARIO_QUEUED_EVENT = "scenario.queued"


def attack_row_id(run_id: uuid.UUID, family: str, ordinal: int) -> uuid.UUID:
    return uuid.uuid5(ATTACK_NAMESPACE, f"{run_id}:{family}:{ordinal}")


def not_found(what: str, identifier: uuid.UUID) -> ApplicationError:
    return permanent_redteam_error(
        RedTeamErrorType.run_not_found, f"{what} {identifier} does not exist"
    )


async def required_run(session: AsyncSession, run_id: uuid.UUID) -> RunRow:
    run = await session.get(RunRow, run_id)
    if run is None or run.target_id is None or run.bundle_id is None:
        raise not_found("red team run", run_id)
    return run


def target_of(run: RunRow) -> uuid.UUID:
    if run.target_id is None:
        raise not_found("target of run", run.id)
    return run.target_id


async def required_bundle(session: AsyncSession, run: RunRow) -> BundleRow:
    bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
    if bundle is None:
        raise not_found("bundle of run", run.id)
    return bundle


def required_channel(bundle: BundleRow, interface_id: str | None) -> AttackChannel:
    manifest = manifest_of(bundle)
    if interface_id is not None:
        manifest = manifest.model_copy(
            update={"interfaces": [item for item in manifest.interfaces if item.id == interface_id]}
        )
    channel = attack_channel(manifest)
    if channel is None:
        named = "the bundle declares no chat interface"
        if interface_id is not None:
            named = f"the bundle declares no chat interface {interface_id!r}"
        raise permanent_redteam_error(RedTeamErrorType.target_not_ready, named)
    return channel


def queued_event(
    run_id: uuid.UUID, scenario: SyntheticScenario, request: SyntheticScenarioRequest
) -> IngestEvent:
    return build_event(
        run_id,
        SCENARIO_QUEUED_EVENT,
        queued_payload(request, scenario),
        f"{SCENARIO_QUEUED_EVENT}:{scenario.run_scenario_id}",
    )


async def create_scenario(
    session: AsyncSession,
    run_id: uuid.UUID,
    channel: AttackChannel,
    family: FamilyDefinition,
    role: str,
    attack_id: uuid.UUID,
    replay: bool,
    attempts: int,
    title: str,
    prompt: str,
) -> tuple[SyntheticScenario, IngestEvent | None]:
    key = attack_scenario_key(attack_id, replay)
    request = SyntheticScenarioRequest(
        run_id=run_id,
        family=SyntheticFamily.redteam,
        key=key,
        title=title,
        role=role,
        interface_id=channel.interface_id,
        attempts=attempts,
        document=attack_scenario_document(channel, role, family, key, title, prompt),
    )
    scenario = await create_synthetic_run_scenario(session, request)
    event = queued_event(run_id, scenario, request) if scenario.created else None
    return scenario, event


def delivered_prompt(family: FamilyDefinition, prompt: str, canary: str) -> str:
    if not family.uses_canary:
        return prompt
    return prompt.replace(CANARY_PLACEHOLDER, canary)


async def prepare_attack(
    session: AsyncSession, settings: WorkerSettings, request: PrepareAttackInput
) -> tuple[PreparedAttack, list[IngestEvent]]:
    run = await required_run(session, request.run_id)
    bundle = await required_bundle(session, run)
    channel = required_channel(bundle, request.interface_id)
    attack_family = family_of(settings, request.family)
    await ensure_attack_ready(
        session, settings, run, bundle, request.role, channel.interface_id, attack_family
    )
    family = attack_family.definition
    prompt = delivered_prompt(family, request.prompt, request.canary)
    attack_id = attack_row_id(request.run_id, request.family, request.ordinal)
    scenario, event = await create_scenario(
        session,
        request.run_id,
        channel,
        family,
        request.role,
        attack_id,
        False,
        1,
        f"Red team {family.title}: attack {request.ordinal + 1}",
        prompt,
    )
    await session.commit()
    prepared = PreparedAttack(
        attack_id=attack_id,
        scenario_id=scenario.scenario_id,
        run_scenario_id=scenario.run_scenario_id,
        interface_id=channel.interface_id,
        prompt=prompt,
        canary=request.canary if family.uses_canary and request.canary in prompt else None,
        session_timeout_seconds=settings.scenario_timeout_seconds,
    )
    return prepared, [] if event is None else [event]


async def prepare_replays(
    session: AsyncSession, settings: WorkerSettings, request: PrepareAttackReplaysInput
) -> tuple[PreparedReplays, list[IngestEvent]]:
    run = await required_run(session, request.run_id)
    channel = required_channel(await required_bundle(session, run), request.interface_id)
    family = family_of(settings, request.family).definition
    scenario, event = await create_scenario(
        session,
        request.run_id,
        channel,
        family,
        request.role,
        request.attack_id,
        True,
        request.replays,
        f"Red team {family.title}: replays of attack {str(request.attack_id)[:8]}",
        request.prompt,
    )
    await session.commit()
    prepared = PreparedReplays(
        scenario_id=scenario.scenario_id,
        run_scenario_id=scenario.run_scenario_id,
        replays=request.replays,
    )
    return prepared, [] if event is None else [event]


async def record_attack(
    session: AsyncSession, request: AssessAttackInput, assessment: AttackAssessment
) -> None:
    values = {
        "run_id": request.run_id,
        "round_id": None,
        "family": request.family,
        "prompt_excerpt": clip_text(redacted_text(" ".join(request.prompt.split())), EXCERPT_LIMIT),
        "response_excerpt": clip_text(
            redacted_text(" ".join(assessment.response_text.split())), EXCERPT_LIMIT
        ),
        "outcome": assessment.outcome,
    }
    await session.execute(
        insert(AttackRow)
        .values(id=request.attack_id, **values)
        .on_conflict_do_update(index_elements=[AttackRow.id], set_=values)
    )
    await session.commit()


async def settle_attack(
    session: AsyncSession, settings: WorkerSettings, request: SettleAttackInput
) -> tuple[uuid.UUID | None, list[IngestEvent]]:
    attack = await session.get(AttackRow, request.attack_id, with_for_update=True)
    if attack is None:
        raise permanent_redteam_error(
            RedTeamErrorType.attack_not_found, f"attack {request.attack_id} does not exist"
        )
    attack.skeptic_verdict = request.skeptic_verdict.model_dump(mode="json")
    events: list[IngestEvent] = []
    if request.confirmed:
        finding_id, events = await file_finding(session, settings, request)
        attack.finding_id = finding_id
    else:
        finding_id = attack.finding_id
    await session.commit()
    return finding_id, events


async def file_finding(
    session: AsyncSession, settings: WorkerSettings, request: SettleAttackInput
) -> tuple[uuid.UUID | None, list[IngestEvent]]:
    run = await required_run(session, request.run_id)
    bundle = await required_bundle(session, run)
    channel = required_channel(bundle, request.interface_id)
    manifest = manifest_of(bundle)
    candidate = confirmed_attack_candidate(
        ConfirmedAttack(
            attack_id=request.attack_id,
            target_id=target_of(run),
            family=family_of(settings, request.family).definition,
            role=request.role,
            role_levels={role.id: role.level for role in manifest.roles},
            interface_id=channel.interface_id,
            scenario_id=request.scenario_id,
            run_scenario_id=request.run_scenario_id,
            step_id=request.assessment.step_id,
            attempt=0,
            prompt=request.prompt,
            response=request.assessment.response_text,
            breach_signal=request.assessment.breach_signal,
            skeptic_reason=request.skeptic_verdict.reason,
            reproduced=request.reproduced,
            replays=request.replays,
        )
    )
    outcome = await upsert_decisions(
        session,
        request.run_id,
        [
            UpsertDecision(
                candidate=candidate,
                match=DedupeMatch(
                    fingerprint=candidate.fingerprint,
                    kind="new",
                    finding_id=None,
                    similarity=None,
                    possible_duplicate_of=None,
                ),
            )
        ],
    )
    finding_id = await session.scalar(
        select(FindingRow.id).where(
            FindingRow.target_id == target_of(run), FindingRow.fingerprint == candidate.fingerprint
        )
    )
    if finding_id is not None and finding_id in outcome.needs_repro:
        try:
            await store_repro(session, finding_id)
        except ReproUnavailableError as error:
            logger.info("redteam_repro_unavailable", extra={"reason": str(error)[:200]})
    return finding_id, list(outcome.events)
