from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import JsonValue

from tessa_api.schemas.bundle import Feature, Invariant
from tessa_api.schemas.enums import (
    AdapterKind,
    AppKind,
    BuiltInInvariantId,
    FeatureKind,
    InvariantCheck,
    InvariantPack,
)
from tessa_api.schemas.invariants import (
    ACTIVE_INVARIANT_IDS,
    INVARIANT_PACK_BY_ID,
    PASSIVE_INVARIANT_IDS,
)
from tessa_api.services.invariants.catalog import BUILT_IN_DEFINITIONS, BUILT_IN_IDS

STATUS_ADAPTERS = frozenset({AdapterKind.http, AdapterKind.sse})
CONFIRMING_FEATURE_KINDS = frozenset({FeatureKind.write, FeatureKind.flow, FeatureKind.admin})
ACTIVE_COMPANION_IDS = (BuiltInInvariantId.no_5xx,)


@dataclass(frozen=True, slots=True)
class AppliedInvariant:
    invariant_id: str
    pack: InvariantPack
    check: InvariantCheck
    params: dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class SelectionContext:
    app_kind: AppKind
    feature: Feature | None
    bundle_invariants: Mapping[str, Invariant]
    adapters: frozenset[AdapterKind]
    active_invariant_id: str | None = None


def declared_params(
    bundle_invariants: Mapping[str, Invariant], invariant_id: str
) -> dict[str, JsonValue]:
    declaration = bundle_invariants.get(invariant_id)
    return dict(declaration.model_extra or {}) if declaration is not None else {}


def built_in_applied(
    invariant_id: BuiltInInvariantId, bundle_invariants: Mapping[str, Invariant]
) -> AppliedInvariant:
    return AppliedInvariant(
        invariant_id=invariant_id.value,
        pack=INVARIANT_PACK_BY_ID[invariant_id],
        check=BUILT_IN_DEFINITIONS[invariant_id].check,
        params=declared_params(bundle_invariants, invariant_id.value),
    )


def target_applied(declaration: Invariant) -> AppliedInvariant:
    return AppliedInvariant(
        invariant_id=declaration.id,
        pack=InvariantPack.target,
        check=InvariantCheck(declaration.check),
        params=dict(declaration.model_extra or {}),
    )


def has_oracle_example(feature: Feature | None) -> bool:
    return feature is not None and any(example.oracle for example in feature.examples)


def asks_for_confirmation(feature: Feature | None) -> bool:
    if feature is None:
        return False
    return feature.kind in CONFIRMING_FEATURE_KINDS or feature.confirmation is not None


def default_passive_ids(context: SelectionContext) -> list[BuiltInInvariantId]:
    ids = [BuiltInInvariantId.latency]
    if context.adapters & STATUS_ADAPTERS:
        ids.append(BuiltInInvariantId.no_5xx)
    if AdapterKind.browser in context.adapters:
        ids.extend([BuiltInInvariantId.no_console_errors, BuiltInInvariantId.accessibility])
    if context.app_kind is AppKind.llm_assistant:
        ids.extend([BuiltInInvariantId.no_internal_ids, BuiltInInvariantId.external_facts_labelled])
        if asks_for_confirmation(context.feature):
            ids.append(BuiltInInvariantId.no_save_claim_before_confirm)
        if has_oracle_example(context.feature):
            ids.extend([BuiltInInvariantId.count_consistency, BuiltInInvariantId.empty_set_honesty])
    if BuiltInInvariantId.pii_by_role.value in context.bundle_invariants:
        ids.append(BuiltInInvariantId.pii_by_role)
    return ids


def listed_applied(context: SelectionContext) -> list[AppliedInvariant]:
    applied: list[AppliedInvariant] = []
    listed = context.feature.invariants if context.feature is not None else []
    for invariant_id in listed:
        if invariant_id in BUILT_IN_IDS:
            built_in = BuiltInInvariantId(invariant_id)
            if built_in in PASSIVE_INVARIANT_IDS:
                applied.append(built_in_applied(built_in, context.bundle_invariants))
            continue
        declaration = context.bundle_invariants.get(invariant_id)
        if declaration is not None:
            applied.append(target_applied(declaration))
    return applied


def synthetic_applied(context: SelectionContext, active_id: str) -> list[AppliedInvariant]:
    if active_id not in BUILT_IN_IDS or BuiltInInvariantId(active_id) not in ACTIVE_INVARIANT_IDS:
        return []
    ids = [BuiltInInvariantId(active_id)]
    if context.adapters & STATUS_ADAPTERS:
        ids.extend(ACTIVE_COMPANION_IDS)
    return [built_in_applied(invariant_id, context.bundle_invariants) for invariant_id in ids]


def applicable_invariants(context: SelectionContext) -> list[AppliedInvariant]:
    if context.active_invariant_id is not None:
        return synthetic_applied(context, context.active_invariant_id)
    applied = [
        built_in_applied(invariant_id, context.bundle_invariants)
        for invariant_id in default_passive_ids(context)
    ]
    applied.extend(listed_applied(context))
    unique: dict[str, AppliedInvariant] = {}
    for item in applied:
        unique.setdefault(item.invariant_id, item)
    return list(unique.values())
