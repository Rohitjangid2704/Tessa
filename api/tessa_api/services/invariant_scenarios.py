import copy
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import JsonValue

from tessa_api.schemas.attack_pack import AttackDefinition
from tessa_api.schemas.bundle import BundleManifest, Feature, Interface, Role
from tessa_api.schemas.bundle_references import ALL_ROLES, PLACEHOLDER_PATTERN
from tessa_api.schemas.enums import (
    AdapterKind,
    AppKind,
    BuiltInInvariantId,
    FeatureKind,
    SkipReason,
    SyntheticFamily,
)
from tessa_api.schemas.plans import PlanSelection
from tessa_api.schemas.scenario import ANONYMOUS_IDENTITY, SCENARIO_SCHEMA_VERSION
from tessa_api.schemas.temporal import InvariantScenarioSkip
from tessa_api.services.invariants.attacks import AttackPack
from tessa_api.services.invariants.params import (
    FORBIDDEN_DENIAL_STATUSES,
    REPLAY_ACCEPTED_STATUSES,
    UNAUTHENTICATED_DENIAL_STATUSES,
    WRITE_SUCCESS_STATUSES,
    ForeignRequest,
    declared_foreign_requests,
    denied_statuses,
)
from tessa_api.services.invariants.selection import declared_params
from tessa_api.services.plan_builder import PlanningContext, interface_accepted
from tessa_api.services.smoke_generator import (
    DEFAULT_ASK_METHOD,
    ROOT_PATH,
    chat_body,
    chat_shape,
    document_hash,
    request_document,
    request_for_example,
    request_of,
    truncated,
)

INVARIANT_FAMILY = SyntheticFamily.invariant.value
SCENARIO_KEY_PREFIX = "inv"
ACTIVE_ORDER = (
    BuiltInInvariantId.auth_boundaries,
    BuiltInInvariantId.role_monotonicity,
    BuiltInInvariantId.tenant_isolation,
    BuiltInInvariantId.idempotent_writes,
    BuiltInInvariantId.refuses_out_of_scope,
    BuiltInInvariantId.injection_resistance,
    BuiltInInvariantId.authority_pressure,
)
ATTACK_INVARIANT_IDS = (
    BuiltInInvariantId.refuses_out_of_scope,
    BuiltInInvariantId.injection_resistance,
    BuiltInInvariantId.authority_pressure,
)
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
NO_AUTH_TYPES = frozenset({"", "none"})
NO_IDEMPOTENCY_TEXTS = frozenset({"", "none", "n/a", "no", "-"})
DEFAULT_IDEMPOTENCY_HEADER = "Idempotency-Key"
IDEMPOTENCY_HEADER_PATTERN = re.compile(r"\b(?:[A-Za-z]+-)*Idempotency(?:-[A-Za-z]+)*\b")
RESET_HOOK_ID = "reset"
PROBE_ASK = "Hello"
MAX_ENDPOINTS = 8
MAX_WRITE_ENDPOINTS = 3
MAX_ATTACKS = 4
LABEL_MAX_LENGTH = 200
TITLE_MAX_LENGTH = 200
KEY_HASH_LENGTH = 16
SKIP_DETAILS: Mapping[SkipReason, str] = {
    SkipReason.env_missing: "a variable the interface needs has no value in the target environment",
    SkipReason.role_unavailable: "the credential variable of the role has no value",
}


@dataclass(frozen=True, slots=True)
class Endpoint:
    method: str
    path: str
    request: dict[str, Any]
    roles: frozenset[str]
    chat: bool = False

    @property
    def writes(self) -> bool:
        return not self.chat and self.method not in SAFE_METHODS

    @property
    def headline(self) -> str:
        return f"{self.method} {self.path}"


@dataclass(frozen=True, slots=True)
class PlannedInvariantScenario:
    invariant_id: BuiltInInvariantId
    role: str
    interface_id: str
    key: str
    document: dict[str, Any]
    document_hash: str


@dataclass(frozen=True, slots=True)
class PlannedSkip:
    invariant_id: BuiltInInvariantId
    role: str | None
    interface_id: str | None
    reason: SkipReason
    detail: str

    def to_result(self) -> InvariantScenarioSkip:
        return InvariantScenarioSkip(
            invariant_id=self.invariant_id.value,
            role=self.role,
            interface_id=self.interface_id,
            skip_reason=self.reason,
        )


@dataclass(frozen=True, slots=True)
class InvariantPlan:
    scenarios: tuple[PlannedInvariantScenario, ...]
    skips: tuple[PlannedSkip, ...]


def scenario_key(invariant_id: BuiltInInvariantId, role: str, interface_id: str) -> str:
    return f"{SCENARIO_KEY_PREFIX}-{invariant_id.value}-{role}-{interface_id}"


def idempotency_header(interface: Interface) -> str | None:
    text = (interface.idempotency or "").strip()
    if text.casefold() in NO_IDEMPOTENCY_TEXTS:
        return None
    found = IDEMPOTENCY_HEADER_PATTERN.search(text)
    return found.group(0) if found is not None else DEFAULT_IDEMPOTENCY_HEADER


def idempotency_key(role: str, endpoint: Endpoint) -> str:
    digest = document_hash({"role": role, "request": endpoint.request})
    return f"tessa-{digest[:KEY_HASH_LENGTH]}"


def placeholder_names(*values: Any) -> frozenset[str]:
    text = " ".join(json.dumps(value, sort_keys=True, default=str) for value in values)
    return frozenset(PLACEHOLDER_PATTERN.findall(text))


def feature_role_ids(feature: Feature, role_ids: Iterable[str]) -> frozenset[str]:
    return frozenset(role_ids) if ALL_ROLES in feature.roles else frozenset(feature.roles)


def has_restore_path(manifest: BundleManifest) -> bool:
    if manifest.seeds is not None and manifest.seeds.reset_script is not None:
        return True
    hooks = manifest.test_hooks
    return hooks is not None and any(hook.id == RESET_HOOK_ID for hook in hooks.available)


def chat_request(
    interface: Mapping[str, Any], shape: Mapping[str, Any], ask: str
) -> dict[str, Any]:
    method = str(shape.get("method") or DEFAULT_ASK_METHOD)
    path = str(shape.get("path") or ROOT_PATH)
    return request_document(
        method, path, str(interface.get("base_path") or ""), body=chat_body(shape, ask)
    )


class InvariantPlanner:
    def __init__(
        self, manifest: BundleManifest, planning: PlanningContext, attacks: AttackPack
    ) -> None:
        self.manifest = manifest
        self.planning = planning
        self.attacks = attacks
        self.roles = list(manifest.roles)
        self.levels = {role.id: role.level for role in manifest.roles}
        self.bundle_invariants = {invariant.id: invariant for invariant in manifest.invariants}
        self.environment_values = {
            variable.name: variable.has_value for variable in planning.variables
        }
        self.scenarios: list[PlannedInvariantScenario] = []
        self.skips: list[PlannedSkip] = []
        self.seen_skips: set[tuple[BuiltInInvariantId, str | None, str | None, SkipReason]] = set()

    def plan(self) -> InvariantPlan:
        for invariant_id in ACTIVE_ORDER:
            scenarios_before, skips_before = len(self.scenarios), len(self.skips)
            self.plan_invariant(invariant_id)
            self.account_for_nothing_planned(invariant_id, scenarios_before, skips_before)
        return InvariantPlan(tuple(self.scenarios), tuple(self.skips))

    def plan_invariant(self, invariant_id: BuiltInInvariantId) -> None:
        match invariant_id:
            case BuiltInInvariantId.auth_boundaries:
                self.plan_auth_boundaries()
            case BuiltInInvariantId.role_monotonicity:
                self.plan_role_monotonicity()
            case BuiltInInvariantId.tenant_isolation:
                self.plan_tenant_isolation()
            case BuiltInInvariantId.idempotent_writes:
                self.plan_idempotent_writes()
            case _:
                self.plan_attack_invariant(invariant_id)

    def account_for_nothing_planned(
        self, invariant_id: BuiltInInvariantId, scenarios_before: int, skips_before: int
    ) -> None:
        if len(self.scenarios) != scenarios_before or len(self.skips) != skips_before:
            return
        if (
            invariant_id in ATTACK_INVARIANT_IDS
            and self.manifest.app.kind is not AppKind.llm_assistant
        ):
            return
        self.skip(
            invariant_id,
            None,
            None,
            SkipReason.precondition_failed,
            "the bundle gives nothing this invariant could be put to the test on",
        )

    def skip(
        self,
        invariant_id: BuiltInInvariantId,
        role: str | None,
        interface_id: str | None,
        reason: SkipReason,
        detail: str,
    ) -> None:
        identity = (invariant_id, role, interface_id, reason)
        if identity in self.seen_skips:
            return
        self.seen_skips.add(identity)
        self.skips.append(PlannedSkip(invariant_id, role, interface_id, reason, detail))

    def interfaces_of(self, *kinds: AdapterKind) -> list[Interface]:
        return [interface for interface in self.manifest.interfaces if interface.kind in kinds]

    def role_skip(self, role: Role, interface: Interface) -> SkipReason | None:
        requirements = self.planning.requirements(role.id, interface.id)
        if requirements.environment_missing():
            return SkipReason.env_missing
        if requirements.credential_missing():
            return SkipReason.role_unavailable
        return None

    def usable_role(
        self, invariant_id: BuiltInInvariantId, role: Role, interface: Interface
    ) -> bool:
        reason = self.role_skip(role, interface)
        if reason is None:
            return True
        self.skip(invariant_id, role.id, interface.id, reason, SKIP_DETAILS[reason])
        return False

    def endpoints_of(self, interface: Interface) -> list[Endpoint]:
        described = interface.model_dump(mode="json")
        role_ids = [role.id for role in self.roles]
        found: dict[tuple[str, str], Endpoint] = {}
        for feature in sorted(self.manifest.features, key=lambda item: item.id):
            if interface.id not in feature.interfaces or feature.kind is FeatureKind.auth:
                continue
            allowed = feature_role_ids(feature, role_ids)
            for example in feature.examples:
                raw = example.model_dump(mode="json")
                if request_of(raw) is None:
                    continue
                built = request_for_example(raw, described)
                if built is None:
                    continue
                document = built[0]
                key = (str(document["method"]), str(document["path"]))
                previous = found.get(key)
                roles = allowed | previous.roles if previous is not None else allowed
                found[key] = Endpoint(key[0], key[1], document, roles)
        return [found[key] for key in sorted(found)]

    def chat_endpoint(self, interface: Interface) -> Endpoint | None:
        described = interface.model_dump(mode="json")
        shape = chat_shape(described)
        if shape is None:
            return None
        request = chat_request(described, shape, PROBE_ASK)
        roles = frozenset(role.id for role in self.roles)
        return Endpoint(str(request["method"]), str(request["path"]), request, roles, chat=True)

    def allowed_endpoints(
        self,
        invariant_id: BuiltInInvariantId,
        role: Role,
        interface: Interface,
        found: Sequence[Endpoint],
    ) -> list[Endpoint]:
        if not self.planning.read_only:
            return list(found)
        kept = [endpoint for endpoint in found if not endpoint.writes]
        if len(kept) < len(found):
            self.skip(
                invariant_id,
                role.id,
                interface.id,
                SkipReason.production_blocked,
                "the run is read-only and the endpoint writes data",
            )
        return kept

    def new_scenario(
        self,
        invariant_id: BuiltInInvariantId,
        role: Role,
        interface: Interface,
        steps: list[dict[str, Any]],
    ) -> None:
        key = scenario_key(invariant_id, role.id, interface.id)
        title = truncated(
            f"Invariant {invariant_id.value}: {role.id} on {interface.id}", TITLE_MAX_LENGTH
        )
        document: dict[str, Any] = {
            "schema_version": SCENARIO_SCHEMA_VERSION,
            "id": key,
            "title": title,
            "family": INVARIANT_FAMILY,
            "role": role.id,
            "interface_id": interface.id,
            "synthetic": True,
            "steps": steps,
        }
        self.scenarios.append(
            PlannedInvariantScenario(
                invariant_id, role.id, interface.id, key, document, document_hash(document)
            )
        )

    def request_step(
        self,
        interface: Interface,
        endpoint: Endpoint,
        label: str,
        statuses: Iterable[int],
        identity: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        request = copy.deepcopy(endpoint.request)
        if headers:
            request["headers"] = {**request.get("headers", {}), **headers}
        expect: dict[str, Any] = {"status": sorted(statuses), "internal_ids": True}
        step: dict[str, Any] = {
            "adapter": "sse" if interface.kind is AdapterKind.sse else "http",
            "label": truncated(label, LABEL_MAX_LENGTH),
            "request": request,
        }
        if interface.kind is AdapterKind.sse:
            expect["non_empty_answer"] = False
            step["ask"] = PROBE_ASK
        step["expect"] = expect
        if identity is not None:
            step["as"] = identity
        return step

    def plan_auth_boundaries(self) -> None:
        invariant_id = BuiltInInvariantId.auth_boundaries
        for interface in self.interfaces_of(AdapterKind.http, AdapterKind.sse):
            if interface.auth is None or interface.auth.type.strip().casefold() in NO_AUTH_TYPES:
                self.skip(
                    invariant_id,
                    None,
                    interface.id,
                    SkipReason.precondition_failed,
                    "the interface declares no authentication",
                )
                continue
            found = self.protected_endpoints(interface)
            for role in self.roles:
                if not self.usable_role(invariant_id, role, interface):
                    continue
                reachable = [endpoint for endpoint in found if role.id in endpoint.roles]
                endpoints = self.allowed_endpoints(invariant_id, role, interface, reachable)
                if not endpoints:
                    continue
                steps = [
                    self.request_step(
                        interface,
                        endpoint,
                        f"anonymous {endpoint.headline}",
                        UNAUTHENTICATED_DENIAL_STATUSES,
                        ANONYMOUS_IDENTITY,
                    )
                    for endpoint in endpoints[:MAX_ENDPOINTS]
                ]
                self.new_scenario(invariant_id, role, interface, steps)

    def protected_endpoints(self, interface: Interface) -> list[Endpoint]:
        if interface.kind is AdapterKind.sse:
            chat = self.chat_endpoint(interface)
            return [] if chat is None else [chat]
        return self.endpoints_of(interface)

    def plan_role_monotonicity(self) -> None:
        invariant_id = BuiltInInvariantId.role_monotonicity
        denied = FORBIDDEN_DENIAL_STATUSES
        for interface in self.interfaces_of(AdapterKind.http):
            found = self.endpoints_of(interface)
            for role in self.roles:
                if not self.usable_role(invariant_id, role, interface):
                    continue
                reserved = [
                    endpoint
                    for endpoint in found
                    if endpoint.roles and self.reserved_for_higher_roles(endpoint, role)
                ]
                endpoints = self.allowed_endpoints(invariant_id, role, interface, reserved)
                if not endpoints:
                    continue
                steps = [
                    self.request_step(interface, endpoint, f"{role.id} {endpoint.headline}", denied)
                    for endpoint in endpoints[:MAX_ENDPOINTS]
                ]
                self.new_scenario(invariant_id, role, interface, steps)

    def reserved_for_higher_roles(self, endpoint: Endpoint, role: Role) -> bool:
        return role.id not in endpoint.roles and all(
            self.levels.get(other, role.level) > role.level for other in endpoint.roles
        )

    def plan_tenant_isolation(self) -> None:
        invariant_id = BuiltInInvariantId.tenant_isolation
        params = declared_params(self.bundle_invariants, invariant_id.value)
        declared = declared_foreign_requests(params)
        for problem in declared.problems:
            self.skip(invariant_id, None, None, SkipReason.precondition_failed, problem)
        if not declared.requests:
            if not declared.problems:
                self.skip(
                    invariant_id,
                    None,
                    None,
                    SkipReason.env_missing,
                    "no second tenant: the bundle declares no tenant_isolation invariant with "
                    "foreign_requests",
                )
            return
        http_interfaces = self.interfaces_of(AdapterKind.http)
        for interface in http_interfaces:
            requests = [
                request
                for request in declared.requests
                if request.interface_id == interface.id
                or (request.interface_id is None and interface is http_interfaces[0])
            ]
            if requests:
                self.plan_foreign_requests(invariant_id, interface, requests, params)

    def plan_foreign_requests(
        self,
        invariant_id: BuiltInInvariantId,
        interface: Interface,
        requests: Sequence[ForeignRequest],
        params: Mapping[str, JsonValue],
    ) -> None:
        denied = denied_statuses(params, FORBIDDEN_DENIAL_STATUSES)
        for role in self.roles:
            if not self.usable_role(invariant_id, role, interface):
                continue
            usable = self.foreign_requests_available(invariant_id, role, interface, requests)
            if not usable:
                continue
            steps = [
                self.foreign_step(interface, request, denied) for request in usable[:MAX_ENDPOINTS]
            ]
            self.new_scenario(invariant_id, role, interface, steps)

    def foreign_requests_available(
        self,
        invariant_id: BuiltInInvariantId,
        role: Role,
        interface: Interface,
        requests: Sequence[ForeignRequest],
    ) -> list[ForeignRequest]:
        available: list[ForeignRequest] = []
        for request in requests:
            missing = sorted(
                name
                for name in placeholder_names(request.path, request.query, request.body)
                if not self.environment_values.get(name, False)
            )
            if missing:
                self.skip(
                    invariant_id,
                    role.id,
                    interface.id,
                    SkipReason.env_missing,
                    f"no value for the second tenant variable {', '.join(missing)}",
                )
            elif self.planning.read_only and request.method not in SAFE_METHODS:
                self.skip(
                    invariant_id,
                    role.id,
                    interface.id,
                    SkipReason.production_blocked,
                    "the run is read-only and the request writes data",
                )
            elif request.method not in SAFE_METHODS and not has_restore_path(self.manifest):
                self.skip(
                    invariant_id,
                    role.id,
                    interface.id,
                    SkipReason.hook_missing,
                    "the bundle offers no reset script or reset hook to undo a write",
                )
            else:
                available.append(request)
        return available

    def foreign_step(
        self, interface: Interface, request: ForeignRequest, denied: frozenset[int]
    ) -> dict[str, Any]:
        document = request_document(
            request.method,
            request.path,
            interface.base_path,
            query=request.query,
            body=request.body,
        )
        endpoint = Endpoint(str(document["method"]), str(document["path"]), document, frozenset())
        label = request.description or f"foreign {endpoint.headline}"
        return self.request_step(interface, endpoint, label, denied)

    def plan_idempotent_writes(self) -> None:
        invariant_id = BuiltInInvariantId.idempotent_writes
        for interface in self.interfaces_of(AdapterKind.http):
            header = idempotency_header(interface)
            if header is None:
                self.skip(
                    invariant_id,
                    None,
                    interface.id,
                    SkipReason.precondition_failed,
                    "the interface declares no idempotency rule",
                )
                continue
            writes = [endpoint for endpoint in self.endpoints_of(interface) if endpoint.writes]
            if writes and not self.planning.read_only and not has_restore_path(self.manifest):
                self.skip(
                    invariant_id,
                    None,
                    interface.id,
                    SkipReason.hook_missing,
                    "the bundle offers no reset script or reset hook to undo the writes",
                )
                continue
            for role in self.roles:
                self.plan_replays(invariant_id, role, interface, header, writes)

    def plan_replays(
        self,
        invariant_id: BuiltInInvariantId,
        role: Role,
        interface: Interface,
        header: str,
        writes: Sequence[Endpoint],
    ) -> None:
        if not self.usable_role(invariant_id, role, interface):
            return
        reachable = [endpoint for endpoint in writes if role.id in endpoint.roles]
        if self.planning.read_only and reachable:
            self.skip(
                invariant_id,
                role.id,
                interface.id,
                SkipReason.production_blocked,
                "the run is read-only and the endpoint writes data",
            )
            return
        steps: list[dict[str, Any]] = []
        for endpoint in reachable[:MAX_WRITE_ENDPOINTS]:
            headers = {header: idempotency_key(role.id, endpoint)}
            steps.append(
                self.request_step(
                    interface,
                    endpoint,
                    f"write {endpoint.headline}",
                    WRITE_SUCCESS_STATUSES,
                    headers=headers,
                )
            )
            steps.append(
                self.request_step(
                    interface,
                    endpoint,
                    f"replay {endpoint.headline}",
                    REPLAY_ACCEPTED_STATUSES,
                    headers=headers,
                )
            )
        if steps:
            self.new_scenario(invariant_id, role, interface, steps)

    def plan_attack_invariant(self, invariant_id: BuiltInInvariantId) -> None:
        if self.manifest.app.kind is not AppKind.llm_assistant:
            return
        attacks = self.attacks.for_invariant(invariant_id)[:MAX_ATTACKS]
        if not attacks:
            self.skip(
                invariant_id,
                None,
                None,
                SkipReason.precondition_failed,
                "the attack pack holds no attack for this invariant",
            )
            return
        chat_interfaces = self.interfaces_of(AdapterKind.sse)
        if not chat_interfaces:
            self.skip(
                invariant_id,
                None,
                None,
                SkipReason.adapter_unsupported,
                "the app declares no sse interface that carries a chat message",
            )
        for interface in chat_interfaces:
            self.plan_attacks_on(invariant_id, interface, attacks)

    def plan_attacks_on(
        self,
        invariant_id: BuiltInInvariantId,
        interface: Interface,
        attacks: Sequence[AttackDefinition],
    ) -> None:
        described = interface.model_dump(mode="json")
        shape = chat_shape(described)
        if shape is None:
            self.skip(
                invariant_id,
                None,
                interface.id,
                SkipReason.precondition_failed,
                "the interface declares no request shape to carry a message",
            )
            return
        for role in self.roles:
            if self.usable_role(invariant_id, role, interface):
                steps = [attack_step(described, shape, attack) for attack in attacks]
                self.new_scenario(invariant_id, role, interface, steps)


def attack_step(
    interface: Mapping[str, Any], shape: Mapping[str, Any], attack: AttackDefinition
) -> dict[str, Any]:
    expect: dict[str, Any] = {"status": 200, "non_empty_answer": True, "internal_ids": True}
    return {
        "adapter": "sse",
        "label": truncated(f"{attack.id}: {attack.description}", LABEL_MAX_LENGTH),
        "ask": attack.prompt,
        "request": chat_request(interface, shape, attack.prompt),
        "expect": expect,
    }


def plan_invariant_scenarios(
    manifest: BundleManifest, planning: PlanningContext, attacks: AttackPack
) -> InvariantPlan:
    return InvariantPlanner(manifest, planning, attacks).plan()


def role_selected(selection: PlanSelection, role: str | None) -> bool:
    every_role = not selection.roles or ALL_ROLES in selection.roles
    return role is None or every_role or role in selection.roles


def interface_selected(
    selection: PlanSelection, interface_kinds: Mapping[str, AdapterKind], interface_id: str | None
) -> bool:
    kind = interface_kinds.get(interface_id) if interface_id is not None else None
    return kind is None or interface_accepted(selection.interface_mode, kind)


def restrict_to_selection(
    plan: InvariantPlan, selection: PlanSelection, interface_kinds: Mapping[str, AdapterKind]
) -> InvariantPlan:
    return InvariantPlan(
        scenarios=tuple(
            scenario
            for scenario in plan.scenarios
            if role_selected(selection, scenario.role)
            and interface_selected(selection, interface_kinds, scenario.interface_id)
        ),
        skips=tuple(
            skip
            for skip in plan.skips
            if role_selected(selection, skip.role)
            and interface_selected(selection, interface_kinds, skip.interface_id)
        ),
    )


@dataclass(slots=True)
class SkipSummary:
    invariant_id: str
    reason: SkipReason
    cells: list[str] = field(default_factory=list)
    details: list[str] = field(default_factory=list)


def summarize_skips(skips: Iterable[PlannedSkip]) -> list[SkipSummary]:
    summaries: dict[tuple[str, SkipReason], SkipSummary] = {}
    for skip in skips:
        summary = summaries.setdefault(
            (skip.invariant_id.value, skip.reason),
            SkipSummary(skip.invariant_id.value, skip.reason),
        )
        cell = "/".join(part for part in (skip.role, skip.interface_id) if part)
        if cell and cell not in summary.cells:
            summary.cells.append(cell)
        if skip.detail not in summary.details:
            summary.details.append(skip.detail)
    return list(summaries.values())
