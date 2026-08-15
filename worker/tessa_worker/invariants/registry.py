from collections.abc import Iterable, Mapping

from tessa_api.schemas.enums import BuiltInInvariantId, InvariantPack
from tessa_api.services.invariants.catalog import built_in_infos
from tessa_api.services.invariants.selection import AppliedInvariant
from tessa_worker.invariants.active.attacks import (
    AuthorityPressureEvaluator,
    InjectionResistanceEvaluator,
    RefusesOutOfScopeEvaluator,
)
from tessa_worker.invariants.active.boundaries import (
    AuthBoundariesEvaluator,
    RoleMonotonicityEvaluator,
    TenantIsolationEvaluator,
)
from tessa_worker.invariants.active.idempotency import IdempotentWritesEvaluator
from tessa_worker.invariants.contracts import InvariantEvaluator
from tessa_worker.invariants.generic.accessibility import AccessibilityEvaluator
from tessa_worker.invariants.generic.latency import LatencyEvaluator
from tessa_worker.invariants.generic.no_5xx import No5xxEvaluator
from tessa_worker.invariants.generic.no_console_errors import NoConsoleErrorsEvaluator
from tessa_worker.invariants.generic.pii_by_role import PiiByRoleEvaluator
from tessa_worker.invariants.llm_app.count_consistency import CountConsistencyEvaluator
from tessa_worker.invariants.llm_app.empty_set_honesty import EmptySetHonestyEvaluator
from tessa_worker.invariants.llm_app.external_facts_labelled import (
    ExternalFactsLabelledEvaluator,
)
from tessa_worker.invariants.llm_app.no_internal_ids import NoInternalIdsEvaluator
from tessa_worker.invariants.llm_app.no_save_claim_before_confirm import (
    NoSaveClaimBeforeConfirmEvaluator,
)
from tessa_worker.invariants.target import TargetInvariantEvaluator


class RegistryError(RuntimeError):
    pass


def build_registry(evaluators: Iterable[InvariantEvaluator]) -> dict[str, InvariantEvaluator]:
    registry: dict[str, InvariantEvaluator] = {}
    for evaluator in evaluators:
        if evaluator.invariant_id in registry:
            raise RegistryError(f"two evaluators are registered for {evaluator.invariant_id}")
        registry[evaluator.invariant_id] = evaluator
    return registry


def verify_registry(registry: Mapping[str, InvariantEvaluator]) -> None:
    catalog = {item.id: item for item in built_in_infos()}
    unevaluated = sorted(set(catalog) - set(registry))
    uncatalogued = sorted(set(registry) - set(catalog))
    if unevaluated or uncatalogued:
        raise RegistryError(
            f"catalog ids without an evaluator: {unevaluated}; "
            f"evaluators without a catalog id: {uncatalogued}"
        )
    mismatched = sorted(
        invariant_id
        for invariant_id, evaluator in registry.items()
        if (evaluator.pack, evaluator.check)
        != (catalog[invariant_id].pack, catalog[invariant_id].check)
    )
    if mismatched:
        raise RegistryError(
            f"evaluators that disagree with the catalog on pack or check: {mismatched}"
        )


BUILT_IN_EVALUATORS: tuple[InvariantEvaluator, ...] = (
    No5xxEvaluator(),
    NoConsoleErrorsEvaluator(),
    AuthBoundariesEvaluator(),
    RoleMonotonicityEvaluator(),
    TenantIsolationEvaluator(),
    IdempotentWritesEvaluator(),
    PiiByRoleEvaluator(),
    AccessibilityEvaluator(),
    LatencyEvaluator(),
    NoSaveClaimBeforeConfirmEvaluator(),
    NoInternalIdsEvaluator(),
    ExternalFactsLabelledEvaluator(),
    RefusesOutOfScopeEvaluator(),
    InjectionResistanceEvaluator(),
    AuthorityPressureEvaluator(),
    CountConsistencyEvaluator(),
    EmptySetHonestyEvaluator(),
)

REGISTRY: Mapping[str, InvariantEvaluator] = build_registry(BUILT_IN_EVALUATORS)
verify_registry(REGISTRY)


def built_in_ids() -> frozenset[str]:
    return frozenset(item.value for item in BuiltInInvariantId)


def evaluator_for(
    applied: AppliedInvariant, registry: Mapping[str, InvariantEvaluator] = REGISTRY
) -> InvariantEvaluator:
    if applied.pack is InvariantPack.target:
        return TargetInvariantEvaluator(applied.invariant_id, applied.check)
    evaluator = registry.get(applied.invariant_id)
    if evaluator is None:
        raise RegistryError(f"no evaluator is registered for {applied.invariant_id}")
    return evaluator
