from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from tessa_api.schemas.bundle_references import ALL_ROLES, PLACEHOLDER_PATTERN
from tessa_api.schemas.catalog import Catalog, CatalogInterface, CatalogItem
from tessa_api.schemas.enums import (
    AdapterKind,
    EnvVarKind,
    FeatureKind,
    InterfaceMode,
    SkipReason,
)
from tessa_api.schemas.plans import PlanSelection, PlanSkippedItem
from tessa_api.services.targets import slugify

SUPPORTED_ADAPTER_KINDS = frozenset(
    {
        AdapterKind.http,
        AdapterKind.sse,
        AdapterKind.browser,
        AdapterKind.websocket,
        AdapterKind.graphql,
    }
)
WRITE_FEATURE_KINDS = frozenset({FeatureKind.write, FeatureKind.admin, FeatureKind.job})
FAMILY_FALLBACK = "general"
NO_CLEANUP = "none"
CLOCK_PINNED_PRECONDITION = "clock.pinned"
PIN_CLOCK_HOOK = "pin_clock"
HOOK_PRECONDITION_PREFIXES = ("hook.", "hook:")
ABSOLUTE_URL_PREFIXES = ("http://", "https://", "ws://", "wss://")


@dataclass(frozen=True, slots=True)
class EnvironmentVariableState:
    name: str
    kind: EnvVarKind
    required: bool
    interface_ids: frozenset[str]
    has_value: bool


@dataclass(frozen=True, slots=True)
class InterfaceAddress:
    interface_id: str
    absolute: bool
    placeholder_names: frozenset[str]


@dataclass(frozen=True, slots=True)
class CellRequirements:
    variables: tuple[EnvironmentVariableState, ...]
    credential_name: str | None
    address_missing: bool

    def missing(self) -> tuple[EnvironmentVariableState, ...]:
        return tuple(variable for variable in self.variables if not variable.has_value)

    def missing_required(self) -> tuple[EnvironmentVariableState, ...]:
        return tuple(variable for variable in self.missing() if variable.required)

    def credential_missing(self) -> bool:
        return self.credential_name is not None and any(
            variable.name == self.credential_name and not variable.has_value
            for variable in self.variables
        )

    def environment_missing(self) -> bool:
        return self.address_missing or any(
            variable.name != self.credential_name for variable in self.missing_required()
        )


@dataclass(frozen=True, slots=True)
class PlanningContext:
    variables: tuple[EnvironmentVariableState, ...]
    role_credentials: Mapping[str, str]
    interface_addresses: Mapping[str, InterfaceAddress]
    available_hooks: frozenset[str]
    read_only: bool

    def requirements(self, role: str, interface_id: str) -> CellRequirements:
        other_credentials = {
            name
            for credential_role, name in self.role_credentials.items()
            if credential_role != role
        }
        address = self.interface_addresses.get(interface_id)
        placeholders = address.placeholder_names if address is not None else frozenset()
        own_credential = self.role_credentials.get(role)
        needed = tuple(
            variable
            for variable in self.variables
            if variable.name not in other_credentials
            and (
                interface_id in variable.interface_ids
                or variable.name in placeholders
                or variable.name == own_credential
            )
        )
        has_url_variable = any(
            variable.kind is EnvVarKind.url and interface_id in variable.interface_ids
            for variable in self.variables
        )
        address_missing = address is not None and not address.absolute and not has_url_variable
        return CellRequirements(
            variables=needed, credential_name=own_credential, address_missing=address_missing
        )


@dataclass(frozen=True, slots=True)
class PlannedCell:
    feature_id: str
    role: str
    interface_id: str
    interface_kind: AdapterKind
    family: str
    skip_reason: SkipReason | None


@dataclass(frozen=True, slots=True)
class CellExpansion:
    cells: tuple[PlannedCell, ...]
    skipped: tuple[PlanSkippedItem, ...]
    warnings: tuple[str, ...]


def string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def mapping_items(value: Any) -> Iterable[Mapping[str, Any]]:
    if not isinstance(value, list):
        return ()
    return (item for item in value if isinstance(item, Mapping))


def family_for_area(area: str) -> str:
    return slugify(area, FAMILY_FALLBACK)


def cleanup_declared(cleanup: str | None) -> bool:
    return (cleanup or "").strip().lower() not in ("", NO_CLEANUP)


def writes_data(kind: FeatureKind, writes_to: str | None, cleanup: str | None) -> bool:
    return (
        kind in WRITE_FEATURE_KINDS
        or writes_to is not None
        or (kind is FeatureKind.flow and cleanup_declared(cleanup))
    )


def is_write_feature(item: CatalogItem) -> bool:
    return writes_data(item.kind, item.writes_to, item.cleanup)


def required_hooks(item: CatalogItem) -> frozenset[str]:
    hooks: set[str] = set()
    for precondition in item.preconditions:
        text = precondition.strip()
        if text == CLOCK_PINNED_PRECONDITION:
            hooks.add(PIN_CLOCK_HOOK)
        for prefix in HOOK_PRECONDITION_PREFIXES:
            if text.startswith(prefix) and len(text) > len(prefix):
                hooks.add(text[len(prefix) :])
    return frozenset(hooks)


def build_planning_context(
    manifest: Mapping[str, Any] | None,
    variables: Sequence[EnvironmentVariableState],
    read_only: bool,
) -> PlanningContext:
    manifest = manifest or {}
    credentials = {
        str(role["id"]): str(role["credential_env"])
        for role in mapping_items(manifest.get("roles"))
        if role.get("id") and role.get("credential_env")
    }
    addresses: dict[str, InterfaceAddress] = {}
    for interface in mapping_items(manifest.get("interfaces")):
        if not interface.get("id"):
            continue
        base_path = str(interface.get("base_path") or "")
        addresses[str(interface["id"])] = InterfaceAddress(
            interface_id=str(interface["id"]),
            absolute=base_path.lower().startswith(ABSOLUTE_URL_PREFIXES),
            placeholder_names=frozenset(PLACEHOLDER_PATTERN.findall(base_path)),
        )
    hooks_section = manifest.get("test_hooks")
    available = frozenset(
        str(hook["id"])
        for hook in mapping_items(
            hooks_section.get("available") if isinstance(hooks_section, Mapping) else None
        )
        if hook.get("id")
    )
    return PlanningContext(
        variables=tuple(variables),
        role_credentials=credentials,
        interface_addresses=addresses,
        available_hooks=available,
        read_only=read_only,
    )


def interface_accepted(mode: InterfaceMode, kind: AdapterKind) -> bool:
    if mode is InterfaceMode.api_only:
        return kind is not AdapterKind.browser
    if mode is InterfaceMode.browser_only:
        return kind is AdapterKind.browser
    return True


def classify_cell(
    item: CatalogItem, role: str, interface: CatalogInterface, context: PlanningContext | None
) -> SkipReason | None:
    if interface.kind not in SUPPORTED_ADAPTER_KINDS:
        return SkipReason.adapter_unsupported
    if context is None:
        return None
    if context.read_only and is_write_feature(item):
        return SkipReason.production_blocked
    if not required_hooks(item) <= context.available_hooks:
        return SkipReason.hook_missing
    requirements = context.requirements(role, interface.id)
    if requirements.environment_missing():
        return SkipReason.env_missing
    if requirements.credential_missing():
        return SkipReason.role_unavailable
    return None


def catalog_items(catalog: Catalog) -> list[CatalogItem]:
    return [item for area in catalog.areas for item in area.items]


def unknown_id_warnings(
    catalog: Catalog, items: Sequence[CatalogItem], selection: PlanSelection, every_role: bool
) -> list[str]:
    version = f"v{catalog.bundle_version}"
    feature_ids = {item.feature_id for item in items}
    area_names = {item.area for item in items}
    role_ids = {role.id for role in catalog.roles}
    warnings = [
        f"Feature {feature_id} is not in bundle {version} and was ignored"
        for feature_id in selection.feature_ids
        if feature_id not in feature_ids
    ]
    warnings.extend(
        f"Area {area} is not in bundle {version} and was ignored"
        for area in selection.area_ids
        if area not in area_names
    )
    if not every_role:
        warnings.extend(
            f"Role {role} is not in bundle {version} and was ignored"
            for role in selection.roles
            if role not in role_ids
        )
    return warnings


def selected_items(items: Sequence[CatalogItem], selection: PlanSelection) -> list[CatalogItem]:
    wanted_features = set(selection.feature_ids)
    wanted_areas = set(selection.area_ids)
    return [
        item for item in items if item.feature_id in wanted_features or item.area in wanted_areas
    ]


def feature_roles(
    item: CatalogItem, catalog_roles: Sequence[str], wanted: Collection[str] | None
) -> list[str]:
    declared = catalog_roles if ALL_ROLES in item.roles else item.roles
    unique = list(dict.fromkeys(declared))
    return [role for role in unique if wanted is None or role in wanted]


def expand_cells(
    catalog: Catalog, selection: PlanSelection, context: PlanningContext | None = None
) -> CellExpansion:
    items = catalog_items(catalog)
    every_role = not selection.roles or ALL_ROLES in selection.roles
    wanted_roles = None if every_role else set(selection.roles)
    warnings = unknown_id_warnings(catalog, items, selection, every_role)
    interfaces = {interface.id: interface for interface in catalog.interfaces}
    role_ids = [role.id for role in catalog.roles]
    cells: list[PlannedCell] = []
    skipped: list[PlanSkippedItem] = []
    seen: set[tuple[str, str, str]] = set()
    for item in selected_items(items, selection):
        roles = feature_roles(item, role_ids, wanted_roles)
        reachable = [
            interfaces[interface_id]
            for interface_id in dict.fromkeys(item.interface_ids)
            if interface_id in interfaces
            and interface_accepted(selection.interface_mode, interfaces[interface_id].kind)
        ]
        if not roles:
            skipped.append(feature_wide_skip(item.feature_id, SkipReason.role_unavailable))
            continue
        if not reachable:
            skipped.append(feature_wide_skip(item.feature_id, SkipReason.adapter_unsupported))
            continue
        family = family_for_area(item.area)
        feature_cells: list[PlannedCell] = []
        for role in roles:
            for interface in reachable:
                key = (item.feature_id, role, interface.id)
                if key in seen:
                    continue
                seen.add(key)
                feature_cells.append(
                    PlannedCell(
                        feature_id=item.feature_id,
                        role=role,
                        interface_id=interface.id,
                        interface_kind=interface.kind,
                        family=family,
                        skip_reason=classify_cell(item, role, interface, context),
                    )
                )
        cells.extend(feature_cells)
        skipped.extend(skipped_items(item.feature_id, feature_cells))
    warnings.extend(expansion_warnings(cells, skipped, context))
    return CellExpansion(cells=tuple(cells), skipped=tuple(skipped), warnings=tuple(warnings))


def feature_wide_skip(feature_id: str, reason: SkipReason) -> PlanSkippedItem:
    return PlanSkippedItem(feature_id=feature_id, role=None, interface_id=None, reason=reason)


FEATURE_WIDE_REASONS = frozenset({SkipReason.hook_missing, SkipReason.production_blocked})


def reason_covers_feature(reason: SkipReason, cells: Sequence[PlannedCell]) -> bool:
    if reason not in FEATURE_WIDE_REASONS:
        return False
    return reason is SkipReason.hook_missing or all(cell.skip_reason is reason for cell in cells)


def skipped_items(feature_id: str, cells: Sequence[PlannedCell]) -> list[PlanSkippedItem]:
    items: list[PlanSkippedItem] = []
    reported_feature_wide: set[SkipReason] = set()
    for cell in cells:
        reason = cell.skip_reason
        if reason is None:
            continue
        if reason_covers_feature(reason, cells):
            if reason not in reported_feature_wide:
                reported_feature_wide.add(reason)
                items.append(feature_wide_skip(feature_id, reason))
            continue
        items.append(
            PlanSkippedItem(
                feature_id=feature_id,
                role=cell.role,
                interface_id=cell.interface_id,
                reason=reason,
            )
        )
    return items


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def expansion_warnings(
    cells: Sequence[PlannedCell],
    skipped: Sequence[PlanSkippedItem],
    context: PlanningContext | None,
) -> list[str]:
    warnings: list[str] = []
    if context is not None and context.read_only:
        write_features = len(
            {item.feature_id for item in skipped if item.reason is SkipReason.production_blocked}
        )
        if write_features:
            warnings.append(
                "The target is a production target: the run is read-only and "
                f"{plural(write_features, 'write feature')} will be skipped"
            )
    unsupported = sum(1 for cell in cells if cell.skip_reason is SkipReason.adapter_unsupported)
    if unsupported:
        warnings.append(
            f"{plural(unsupported, 'cell')} use an interface kind that is not supported yet"
        )
    return warnings


def runnable_cells(cells: Iterable[PlannedCell]) -> list[PlannedCell]:
    return [cell for cell in cells if cell.skip_reason is None]
