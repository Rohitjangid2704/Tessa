from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from tessa_api.schemas.catalog import CatalogItem
from tessa_api.schemas.enums import (
    CellStatus,
    Confidence,
    Depth,
    GenerationVariant,
    ScenarioStatus,
    SkipReason,
)
from tessa_api.services.plan_builder import (
    PlanningContext,
    cleanup_declared,
    is_write_feature,
)

CellKey = tuple[str, str, str]

PARAPHRASES_AT_STANDARD = 3
NEGATIVES_AT_STANDARD = 2
ADVERSARIALS_AT_DEEP = 2
VARIANT_KEY = "variant"
SEED_PRECONDITION_PREFIXES = ("seed.", "seed:")
GENERATION_FAILURE_PREFIX = "Generation failed: "
LIVE_SCENARIO_STATUSES = frozenset(
    {
        ScenarioStatus.draft,
        ScenarioStatus.validating,
        ScenarioStatus.in_review,
        ScenarioStatus.accepted,
    }
)
SETTLED_FROM_SCENARIOS = frozenset({CellStatus.generated, CellStatus.covered})

SKIP_EXPLANATIONS: Mapping[SkipReason, str] = {
    SkipReason.adapter_unsupported: "The interface kind has no adapter yet",
    SkipReason.hook_missing: "The feature needs a test hook the bundle does not offer",
    SkipReason.production_blocked: "The target is a production target and the feature writes data",
    SkipReason.env_missing: "A variable the cell needs has no value in the target environment",
    SkipReason.role_unavailable: "The credential variable of the role has no value",
}


@dataclass(frozen=True, slots=True)
class ScenarioFact:
    status: ScenarioStatus
    variant: GenerationVariant | None


@dataclass(frozen=True, slots=True)
class CellDecision:
    status: CellStatus
    reason: str | None
    skip_reason: SkipReason | None


def variant_of(provenance: Mapping[str, Any] | None) -> GenerationVariant | None:
    raw = (provenance or {}).get(VARIANT_KEY)
    if not isinstance(raw, str):
        return None
    try:
        return GenerationVariant(raw)
    except ValueError:
        return None


def required_variants(depth: Depth, other_roles: int) -> dict[GenerationVariant, int]:
    if depth is Depth.smoke:
        return {}
    required = {
        GenerationVariant.paraphrase: PARAPHRASES_AT_STANDARD,
        GenerationVariant.negative: NEGATIVES_AT_STANDARD,
    }
    if other_roles > 0:
        required[GenerationVariant.role_variant] = other_roles
    if depth is Depth.deep:
        required[GenerationVariant.adversarial] = ADVERSARIALS_AT_DEEP
    return required


def scenario_status(
    facts: Iterable[ScenarioFact], depth: Depth, other_roles: int
) -> CellStatus | None:
    live = [fact for fact in facts if fact.status in LIVE_SCENARIO_STATUSES]
    if not live:
        return None
    accepted = Counter(fact.variant for fact in live if fact.status is ScenarioStatus.accepted)
    if accepted[None] < 1:
        return CellStatus.generated
    for variant, needed in required_variants(depth, other_roles).items():
        if accepted[variant] < needed:
            return CellStatus.generated
    return CellStatus.covered


def settled_status(
    current: CellStatus, facts: Sequence[ScenarioFact], depth: Depth, other_roles: int
) -> CellStatus:
    from_scenarios = scenario_status(facts, depth, other_roles)
    if from_scenarios is None:
        return CellStatus.empty if current in SETTLED_FROM_SCENARIOS else current
    return current if current is CellStatus.blocked else from_scenarios


def manifest_declares_seed(manifest: Mapping[str, Any] | None) -> bool:
    seeds = (manifest or {}).get("seeds")
    return isinstance(seeds, Mapping) and bool(
        seeds.get("reset_script") or seeds.get("hash_command")
    )


def unmet_preconditions(preconditions: Iterable[str], seed_declared: bool) -> list[str]:
    return [
        text
        for text in (precondition.strip() for precondition in preconditions)
        if text.startswith(SEED_PRECONDITION_PREFIXES) and not seed_declared
    ]


def author_reason(item: CatalogItem, has_sources: bool, seed_declared: bool) -> str | None:
    if item.confidence is Confidence.low:
        return "The bundle rates this feature's confidence as low, so it needs code knowledge"
    if not has_sources:
        return "The bundle has no example or flow to build a scenario for this cell from"
    unmet = unmet_preconditions(item.preconditions, seed_declared)
    if unmet:
        return f"Unmet precondition: {', '.join(unmet)}; the bundle declares no seed material"
    if is_write_feature(item):
        if not cleanup_declared(item.cleanup):
            return "The feature writes data and the bundle declares no cleanup for it"
        if item.expect_db is None:
            return "The feature writes data and the bundle declares no expect_db check for it"
    return None


def skip_explanation(
    skip_reason: SkipReason, context: PlanningContext | None, role: str, interface_id: str
) -> str:
    base = SKIP_EXPLANATIONS.get(skip_reason, skip_reason.value)
    if context is None:
        return base
    requirements = context.requirements(role, interface_id)
    if skip_reason is SkipReason.env_missing:
        names = [variable.name for variable in requirements.missing_required()]
        if names:
            return f"{base}: {', '.join(names)}"
        if requirements.address_missing:
            return f"No url variable lists interface {interface_id}"
    if skip_reason is SkipReason.role_unavailable and requirements.credential_name is not None:
        return f"{base}: {requirements.credential_name}"
    return base


def is_generation_failure(reason: str | None) -> bool:
    return reason is not None and reason.startswith(GENERATION_FAILURE_PREFIX)


def decide_cell(
    skip_reason: SkipReason | None,
    explanation: str | None,
    facts: Sequence[ScenarioFact],
    depth: Depth,
    other_roles: int,
    static_author_reason: str | None,
    persisted_status: CellStatus,
    persisted_reason: str | None,
) -> CellDecision:
    if skip_reason is not None:
        return CellDecision(CellStatus.blocked, explanation, skip_reason)
    from_scenarios = scenario_status(facts, depth, other_roles)
    if from_scenarios is not None:
        return CellDecision(from_scenarios, None, None)
    if static_author_reason is not None:
        return CellDecision(CellStatus.needs_author, static_author_reason, None)
    if persisted_status is CellStatus.needs_author and is_generation_failure(persisted_reason):
        return CellDecision(CellStatus.needs_author, persisted_reason, None)
    return CellDecision(CellStatus.empty, None, None)
