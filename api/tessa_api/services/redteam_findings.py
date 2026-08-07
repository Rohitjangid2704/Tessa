import uuid
from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import JsonValue

from tessa_api.schemas.attack_family import FamilyDefinition
from tessa_api.schemas.model_calls import EMBED_MAX_TEXT_CHARS
from tessa_api.schemas.temporal import FindingCandidate
from tessa_api.services.findings.classify import class_of_invariant
from tessa_api.services.findings.fingerprint import compute_fingerprint, normalize_signal
from tessa_api.services.findings.severity import role_standing, severity_for
from tessa_api.services.findings.signals import compact_value, safe_text
from tessa_api.services.grading_rules import clip_text
from tessa_api.services.redteam_channel import REDTEAM_FAMILY

CHECK_PREFIX = "redteam:"
TITLE_LIMIT = 200
EVIDENCE_TEXT_LIMIT = 300
SKEPTIC_REASON_LIMIT = 300


@dataclass(frozen=True, slots=True)
class ConfirmedAttack:
    attack_id: uuid.UUID
    target_id: uuid.UUID
    family: FamilyDefinition
    role: str
    role_levels: Mapping[str, int]
    interface_id: str
    scenario_id: uuid.UUID
    run_scenario_id: uuid.UUID
    step_id: uuid.UUID | None
    attempt: int
    prompt: str
    response: str
    breach_signal: str
    skeptic_reason: str | None
    reproduced: int
    replays: int


def redteam_check(family_id: str) -> str:
    return f"{CHECK_PREFIX}{family_id}"


def finding_title(confirmed: ConfirmedAttack) -> str:
    return clip_text(
        f"Red team breach: {confirmed.family.title} as {confirmed.role} on "
        f"{confirmed.interface_id}",
        TITLE_LIMIT,
    )


def finding_evidence(confirmed: ConfirmedAttack) -> dict[str, JsonValue]:
    evidence: dict[str, JsonValue] = {
        "check": redteam_check(confirmed.family.id),
        "family": confirmed.family.id,
        "attack_id": str(confirmed.attack_id),
        "attack_prompt": safe_text(confirmed.prompt, EVIDENCE_TEXT_LIMIT),
        "response": safe_text(confirmed.response, EVIDENCE_TEXT_LIMIT),
        "breach_signal": safe_text(confirmed.breach_signal, EVIDENCE_TEXT_LIMIT),
        "reproduced": f"{confirmed.reproduced} of {confirmed.replays} replays",
    }
    if confirmed.skeptic_reason:
        evidence["skeptic"] = safe_text(confirmed.skeptic_reason, SKEPTIC_REASON_LIMIT)
    return evidence


def confirmed_attack_candidate(confirmed: ConfirmedAttack) -> FindingCandidate:
    family = confirmed.family
    finding_class = class_of_invariant(family.invariant_id.value)
    signal = normalize_signal(f"redteam {family.id} breach confirmed")
    check = redteam_check(family.id)
    title = finding_title(confirmed)
    return FindingCandidate(
        fingerprint=compute_fingerprint(
            confirmed.target_id,
            finding_class,
            check,
            None,
            confirmed.interface_id,
            confirmed.role,
            signal,
        ),
        finding_class=finding_class,
        severity=severity_for(
            finding_class, None, role_standing(confirmed.role_levels, confirmed.role)
        ),
        title=title,
        invariant_id=family.invariant_id.value,
        scenario_id=confirmed.scenario_id,
        run_scenario_id=confirmed.run_scenario_id,
        step_id=confirmed.step_id,
        attempt=confirmed.attempt,
        feature_id=None,
        interface_id=confirmed.interface_id,
        role=confirmed.role,
        family=REDTEAM_FAMILY,
        signal=signal,
        embedding_text=clip_text(f"{finding_class.value}: {title}. {signal}", EMBED_MAX_TEXT_CHARS),
        evidence=finding_evidence(confirmed),
        expected=f"invariant {family.invariant_id.value} holds under {family.title.lower()}",
        actual=compact_value(confirmed.response),
    )
