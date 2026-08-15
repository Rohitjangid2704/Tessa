import logging
from collections.abc import Mapping, Sequence

from sqlalchemy import update
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.attack_family import FamilyDefinition
from tessa_api.schemas.enums import AdapterKind, Tier0Check
from tessa_api.schemas.temporal import SKEPTIC_TEXT_MAX_CHARS
from tessa_api.services.grading_rules import clip_text, redacted_text
from tessa_api.services.secret_scan import scan_text
from tessa_api.services.settings_service import effective_settings
from tessa_worker.activities.grading import probe_polarity
from tessa_worker.activities.grading_models import ProbePolarity
from tessa_worker.activities.redteam_models import (
    ASSESSMENT_TEXT_MAX_CHARS,
    AssessAttackInput,
    AttackAssessment,
)
from tessa_worker.invariants.contracts import InvariantStep, ProbeRunner
from tessa_worker.invariants.loading import load_invariant_steps
from tessa_worker.invariants.probing import ProbeJudgement, ProbeSummary, ask_probes, summarize
from tessa_worker.invariants.steps import answer_of, response_status, response_texts
from tessa_worker.lab.redteam.context import manifest_of
from tessa_worker.lab.redteam.families import family_of
from tessa_worker.lab.redteam.outcome import (
    SUCCESS_CEILING,
    SUCCESS_FLOOR,
    AttackEvidence,
    classify_attack,
    delivery_problem,
)
from tessa_worker.lab.redteam.store import required_bundle, required_run
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.lab.redteam")

REPLY_TEXT_LIMIT = 4000
FIRST_STEP_INDEX = 0


def reply_of(step: InvariantStep) -> str | None:
    answer = answer_of(step)
    if answer is not None or step.adapter is not AdapterKind.http:
        return answer
    joined = "\n".join(response_texts(step)).strip()
    return clip_text(redacted_text(joined), REPLY_TEXT_LIMIT) if joined else None


def internal_id_failures_of(step: InvariantStep) -> int:
    return sum(1 for failure in step.tier0.failures if failure.check is Tier0Check.internal_ids)


def secret_patterns_of(reply: str | None) -> tuple[str, ...]:
    if reply is None:
        return ()
    return tuple(dict.fromkeys(hit.pattern for hit in scan_text("reply", reply)))


def answered_successfully(status: int | None, reply: str | None) -> bool:
    return (
        status is not None
        and SUCCESS_FLOOR <= status < SUCCESS_CEILING
        and bool(reply and reply.strip())
    )


async def probe_summary(
    probes: ProbeRunner,
    step: InvariantStep,
    probe_ids: Sequence[str],
    polarity: Mapping[str, ProbePolarity],
) -> ProbeSummary | None:
    if not probe_ids:
        return None
    try:
        return summarize(await ask_probes(probes, step.step_id, probe_ids, polarity))
    except ApplicationError as error:
        logger.warning("redteam_probes_unavailable", extra={"reason": str(error)[:200]})
        return ProbeSummary(ProbeJudgement.unavailable, None, tuple(probe_ids))


async def store_step_texts(
    session_factory: SessionFactory, step: InvariantStep, prompt: str, reply: str | None
) -> None:
    values: dict[str, str] = {}
    if step.ask is None:
        values["ask"] = prompt
    if step.answer is None and reply is not None:
        values["answer"] = reply
    if not values:
        return
    async with session_factory() as session:
        await session.execute(update(StepRow).where(StepRow.id == step.step_id).values(**values))
        await session.commit()


def missing_step_evidence(request: AssessAttackInput) -> AttackEvidence:
    reason = request.delivery.error or f"the attempt ended as {request.delivery.status.value}"
    return AttackEvidence(
        answer=None,
        http_status=None,
        delivery_error=reason,
        canary=request.canary,
        internal_id_failures=0,
        secret_patterns=(),
        probes=None,
    )


async def evidence_of(
    request: AssessAttackInput,
    family: FamilyDefinition,
    step: InvariantStep,
    probes: ProbeRunner,
    polarity: Mapping[str, ProbePolarity],
    session_factory: SessionFactory,
) -> AttackEvidence:
    reply = reply_of(step)
    status = response_status(step)
    await store_step_texts(session_factory, step, request.prompt, reply)
    readable = step.model_copy(update={"ask": step.ask or request.prompt, "answer": reply})
    summary = (
        await probe_summary(probes, readable, family.breach_probes, polarity)
        if answered_successfully(status, reply)
        else None
    )
    return AttackEvidence(
        answer=reply,
        http_status=status,
        delivery_error=(
            "the target step did not complete" if step.ok is False and status is None else None
        ),
        canary=request.canary,
        internal_id_failures=internal_id_failures_of(step),
        secret_patterns=secret_patterns_of(reply),
        probes=summary,
    )


async def assess_attack(
    session_factory: SessionFactory,
    settings: WorkerSettings,
    probes: ProbeRunner,
    request: AssessAttackInput,
) -> AttackAssessment:
    family = family_of(settings, request.family).definition
    async with session_factory() as session:
        run = await required_run(session, request.run_id)
        manifest = manifest_of(await required_bundle(session, run))
        effective = await effective_settings(session, settings)
        steps = await load_invariant_steps(session, request.run_scenario_id, request.attempt)
    step = next((item for item in steps if item.index == FIRST_STEP_INDEX), None)
    evidence = (
        missing_step_evidence(request)
        if step is None
        else await evidence_of(
            request,
            family,
            step,
            probes,
            probe_polarity(effective, manifest),
            session_factory,
        )
    )
    classified = classify_attack(family, evidence)
    return AttackAssessment(
        outcome=classified.outcome,
        delivered=delivery_problem(evidence) is None,
        tier=classified.tier,
        confidence=classified.confidence,
        breach_signal=clip_text(classified.signal, ASSESSMENT_TEXT_MAX_CHARS),
        response_text=clip_text(redacted_text(evidence.answer or ""), SKEPTIC_TEXT_MAX_CHARS),
        step_id=None if step is None else step.step_id,
    )
