from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from tessa_api.schemas.bundle_references import (
    ALL_ROLES,
    LOOSE_PLACEHOLDER_PATTERN,
    PLACEHOLDER_PATTERN,
    walk_strings,
)
from tessa_api.schemas.enums import AdapterKind, FeatureKind
from tessa_api.schemas.scenario import ANONYMOUS_IDENTITY, HttpStep, ScenarioDoc, SseStep
from tessa_api.schemas.scenarios import ScenarioIssue, ScenarioValidation
from tessa_api.services.manifest_loader import (
    LoadedDocument,
    PointerMap,
    load_yaml_document,
    to_pointer,
)
from tessa_api.services.plan_builder import cleanup_declared, writes_data
from tessa_api.services.scenario_truth_checks import OracleView, check_truth_references
from tessa_api.services.scenario_variables import BUILT_IN_VARIABLES, built_in_names

SCENARIO_FILE = "scenario.yaml"
MAX_REPORTED_ISSUES = 100
MAX_SCENARIO_BYTES = 256 * 1024
MISSING_FIELD_ERROR = "missing"
MAX_LISTED_NAMES = 20
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
TOOLS_KEY = "tools"
STEPS_KEY = "steps"

STEP_KINDS_BY_INTERFACE_KIND: Mapping[AdapterKind, frozenset[str]] = {
    AdapterKind.http: frozenset({"http"}),
    AdapterKind.sse: frozenset({"sse", "http"}),
    AdapterKind.browser: frozenset({"browser"}),
    AdapterKind.websocket: frozenset({"websocket"}),
    AdapterKind.graphql: frozenset({"graphql"}),
}

Location = tuple[str | int, ...]


@dataclass(frozen=True, slots=True)
class FeatureReach:
    interface_ids: frozenset[str]
    role_ids: frozenset[str]
    kind: FeatureKind | None = None
    writes: bool = False
    cleanup_declared: bool = False


@dataclass(frozen=True, slots=True)
class BundleVocabulary:
    feature_ids: tuple[str, ...]
    role_ids: tuple[str, ...]
    interface_ids: tuple[str, ...]
    oracle_names: tuple[str, ...]
    tool_names: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ScenarioBundleView:
    role_ids: frozenset[str]
    interface_kinds: Mapping[str, AdapterKind]
    features: Mapping[str, FeatureReach]
    environment_names: frozenset[str]
    oracles: Mapping[str, OracleView] = field(default_factory=dict)
    tool_names: frozenset[str] = frozenset()

    def vocabulary(self) -> BundleVocabulary:
        return BundleVocabulary(
            feature_ids=tuple(sorted(self.features)),
            role_ids=tuple(sorted(self.role_ids)),
            interface_ids=tuple(sorted(self.interface_kinds)),
            oracle_names=tuple(sorted(self.oracles)),
            tool_names=tuple(sorted(self.tool_names)),
        )


@dataclass(frozen=True, slots=True)
class ScenarioCheck:
    validation: ScenarioValidation
    document: ScenarioDoc | None
    parsed: dict[str, Any] | None


@dataclass
class IssueCollector:
    pointers: PointerMap
    errors: list[ScenarioIssue] = field(default_factory=list)
    warnings: list[ScenarioIssue] = field(default_factory=list)

    def add(self, severity: str, code: str, message: str, loc: Location) -> None:
        target = self.errors if severity == "error" else self.warnings
        if len(target) >= MAX_REPORTED_ISSUES:
            return
        pointer = to_pointer(loc)
        found = self.pointers.locate(pointer)
        target.append(
            ScenarioIssue(
                code=code,
                pointer=pointer,
                line=found[0] if found else None,
                column=found[1] if found else None,
                message=message,
            )
        )

    def error(self, code: str, message: str, loc: Location) -> None:
        self.add("error", code, message, loc)

    def warning(self, code: str, message: str, loc: Location) -> None:
        self.add("warning", code, message, loc)

    def validation(self) -> ScenarioValidation:
        return ScenarioValidation(
            valid=not self.errors, errors=list(self.errors), warnings=list(self.warnings)
        )


def string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def mapping_items(value: Any) -> Iterable[Mapping[str, Any]]:
    if not isinstance(value, list):
        return ()
    return (item for item in value if isinstance(item, Mapping))


def known_interface_kind(value: Any) -> AdapterKind | None:
    try:
        return AdapterKind(value)
    except ValueError:
        return None


def known_feature_kind(value: Any) -> FeatureKind | None:
    try:
        return FeatureKind(value)
    except ValueError:
        return None


def declared_tool_names(manifest: Mapping[str, Any]) -> frozenset[str]:
    names: set[str] = set()
    for section in ("interfaces", "features"):
        for entry in mapping_items(manifest.get(section)):
            declared = entry.get(TOOLS_KEY)
            for tool in declared if isinstance(declared, list) else ():
                if isinstance(tool, str) and tool.strip():
                    names.add(tool.strip())
                elif isinstance(tool, Mapping) and str(tool.get("name") or "").strip():
                    names.add(str(tool["name"]).strip())
    return frozenset(names)


def feature_reach(feature: Mapping[str, Any], role_ids: frozenset[str]) -> FeatureReach:
    roles = frozenset(string_list(feature.get("roles")))
    kind = known_feature_kind(feature.get("kind"))
    writes_to = feature.get("writes_to")
    cleanup = feature.get("cleanup")
    return FeatureReach(
        interface_ids=frozenset(string_list(feature.get("interfaces"))),
        role_ids=role_ids if ALL_ROLES in roles else roles,
        kind=kind,
        writes=kind is not None
        and writes_data(
            kind, str(writes_to) if writes_to is not None else None, str(cleanup or "")
        ),
        cleanup_declared=cleanup_declared(str(cleanup) if cleanup is not None else None),
    )


def build_scenario_view(
    manifest: Mapping[str, Any] | None,
    environment_names: Collection[str],
    oracles: Iterable[OracleView] = (),
) -> ScenarioBundleView:
    manifest = manifest or {}
    role_ids = frozenset(
        str(role["id"]) for role in mapping_items(manifest.get("roles")) if "id" in role
    )
    interface_kinds: dict[str, AdapterKind] = {}
    for interface in mapping_items(manifest.get("interfaces")):
        kind = known_interface_kind(interface.get("kind"))
        if "id" in interface and kind is not None:
            interface_kinds[str(interface["id"])] = kind
    features = {
        str(feature["id"]): feature_reach(feature, role_ids)
        for feature in mapping_items(manifest.get("features"))
        if "id" in feature
    }
    return ScenarioBundleView(
        role_ids=role_ids,
        interface_kinds=interface_kinds,
        features=features,
        environment_names=frozenset(environment_names),
        oracles={oracle.name: oracle for oracle in oracles},
        tool_names=declared_tool_names(manifest),
    )


def child_of(node: Any, part: str | int) -> tuple[bool, Any]:
    if isinstance(node, dict) and isinstance(part, str) and part in node:
        return True, node[part]
    if isinstance(node, list) and isinstance(part, int) and 0 <= part < len(node):
        return True, node[part]
    return False, None


def resolvable_location(data: Any, loc: Sequence[str | int], keeps_missing_leaf: bool) -> Location:
    kept: list[str | int] = []
    node = data
    last_index = len(loc) - 1
    for index, part in enumerate(loc):
        found, child = child_of(node, part)
        if found:
            kept.append(part)
            node = child
        elif index == last_index and keeps_missing_leaf:
            kept.append(part)
    return tuple(kept)


def collect_model_errors(collector: IssueCollector, error: ValidationError, data: Any) -> None:
    for item in error.errors():
        loc = resolvable_location(data, item["loc"], item["type"] == MISSING_FIELD_ERROR)
        collector.error(str(item["type"]), str(item["msg"]), loc)


def check_placeholders(
    collector: IssueCollector, data: Any, environment_names: frozenset[str]
) -> None:
    for loc, text in walk_strings(data, ()):
        for match in LOOSE_PLACEHOLDER_PATTERN.finditer(text):
            name = match.group(1)
            if PLACEHOLDER_PATTERN.fullmatch(match.group(0)) is None:
                collector.error(
                    "invalid_placeholder",
                    f"Placeholder ${{{name}}} must use upper case letters, digits and "
                    "underscores and start with a letter, for example ${BASE_URL}",
                    loc,
                )
            elif name not in environment_names:
                collector.error(
                    "unknown_environment_variable",
                    f"Placeholder ${{{name}}} is not a variable of the target environment",
                    loc,
                )


def check_identity(
    collector: IssueCollector,
    view: ScenarioBundleView,
    role: str,
    loc: Location,
    anonymous_allowed: bool,
) -> None:
    if anonymous_allowed and role == ANONYMOUS_IDENTITY:
        return
    if role not in view.role_ids:
        collector.error(
            "unknown_role",
            f"Role {role!r} is not declared in the bundle roles",
            loc,
        )


def check_interface(
    collector: IssueCollector, view: ScenarioBundleView, document: ScenarioDoc
) -> AdapterKind | None:
    kind = view.interface_kinds.get(document.interface_id)
    if kind is None:
        collector.error(
            "unknown_interface",
            f"Interface {document.interface_id!r} is not declared in the bundle interfaces",
            ("interface_id",),
        )
        return None
    if kind not in STEP_KINDS_BY_INTERFACE_KIND:
        supported = ", ".join(sorted(item.value for item in STEP_KINDS_BY_INTERFACE_KIND))
        collector.error(
            "interface_kind_unsupported",
            f"Interface {document.interface_id!r} is of kind {kind.value}, which Tessa cannot "
            f"drive yet; supported kinds are {supported}",
            ("interface_id",),
        )
        return None
    return kind


def check_steps(
    collector: IssueCollector,
    view: ScenarioBundleView,
    document: ScenarioDoc,
    interface_kind: AdapterKind | None,
) -> None:
    allowed = STEP_KINDS_BY_INTERFACE_KIND[interface_kind] if interface_kind is not None else None
    for index, step in enumerate(document.steps):
        if interface_kind is not None and allowed is not None and step.adapter not in allowed:
            collector.error(
                "step_kind_unsupported",
                f"A {step.adapter} step cannot run on interface {document.interface_id!r} of kind "
                f"{interface_kind.value}; use {' or '.join(sorted(allowed))}",
                (STEPS_KEY, index, "adapter"),
            )
        if step.as_ is not None:
            check_identity(collector, view, step.as_, (STEPS_KEY, index, "as"), True)


def braced(name: str) -> str:
    return "{{" + name + "}}"


def check_built_ins(collector: IssueCollector, data: Any) -> None:
    known = ", ".join(braced(item) for item in sorted(BUILT_IN_VARIABLES))
    for loc, text in walk_strings(data, ()):
        for name in built_in_names(text):
            if name not in BUILT_IN_VARIABLES:
                collector.warning(
                    "unknown_built_in_variable",
                    f"{braced(name)} is not a built-in variable; the built-ins are {known}",
                    loc,
                )
            elif not inside_steps(loc):
                collector.error(
                    "built_in_not_available",
                    f"{braced(name)} is not available here; it is only resolved inside steps",
                    loc,
                )


def inside_steps(loc: Location) -> bool:
    return bool(loc) and loc[0] == STEPS_KEY


def check_feature_reach(
    collector: IssueCollector, view: ScenarioBundleView, document: ScenarioDoc
) -> None:
    if document.feature_id is None:
        return
    reach = view.features.get(document.feature_id)
    if reach is None:
        collector.error(
            "unknown_feature",
            f"Feature {document.feature_id!r} is not declared in the bundle features",
            ("feature_id",),
        )
        return
    if document.interface_id in view.interface_kinds and document.interface_id not in (
        reach.interface_ids
    ):
        collector.warning(
            "interface_not_listed_for_feature",
            f"Feature {document.feature_id!r} does not list interface {document.interface_id!r}",
            ("interface_id",),
        )
    if document.role in view.role_ids and document.role not in reach.role_ids:
        collector.warning(
            "role_not_listed_for_feature",
            f"Feature {document.feature_id!r} does not list role {document.role!r}",
            ("role",),
        )


def check_truth(collector: IssueCollector, view: ScenarioBundleView, document: ScenarioDoc) -> None:
    for issue in check_truth_references(document, view.oracles):
        collector.add(issue.severity, issue.code, issue.message, issue.loc)


def tool_references(document: ScenarioDoc) -> Iterable[tuple[str, Location]]:
    for index, step in enumerate(document.steps):
        if not isinstance(step, SseStep) or step.expect.tools is None:
            continue
        base: Location = ("steps", index, "expect", "tools")
        for group, references in (
            ("include", step.expect.tools.include),
            ("exclude", step.expect.tools.exclude),
        ):
            for position, reference in enumerate(references):
                if isinstance(reference, str):
                    yield reference, (*base, group, position)
                else:
                    yield reference.name, (*base, group, position, "name")


def known_tools_message(name: str, known: frozenset[str]) -> str:
    listed = sorted(known)
    shown = ", ".join(listed[:MAX_LISTED_NAMES])
    more = f" and {len(listed) - MAX_LISTED_NAMES} more" if len(listed) > MAX_LISTED_NAMES else ""
    return f"Tool {name!r} is not a tool of the bundle; the bundle declares: {shown}{more}"


def check_tools(collector: IssueCollector, view: ScenarioBundleView, document: ScenarioDoc) -> None:
    references = list(tool_references(document))
    if not references:
        return
    if not view.tool_names:
        collector.warning(
            "tool_vocabulary_not_declared",
            "The bundle declares no tools (list them under tools: on an interface or a feature "
            "in manifest.yaml), so tool names cannot be checked",
            references[0][1],
        )
        return
    for name, loc in references:
        if name not in view.tool_names:
            collector.error("unknown_tool", known_tools_message(name, view.tool_names), loc)


def check_references(
    collector: IssueCollector, view: ScenarioBundleView, document: ScenarioDoc
) -> None:
    check_identity(collector, view, document.role, ("role",), False)
    interface_kind = check_interface(collector, view, document)
    check_steps(collector, view, document, interface_kind)
    check_feature_reach(collector, view, document)
    check_truth(collector, view, document)
    check_tools(collector, view, document)


def check_lints(collector: IssueCollector, view: ScenarioBundleView, document: ScenarioDoc) -> None:
    if document.feature_id is None:
        if not document.synthetic:
            collector.warning(
                "feature_missing",
                "The scenario names no feature_id, so it belongs to no coverage cell",
                ("feature_id",),
            )
        return
    reach = view.features.get(document.feature_id)
    if reach is None:
        return
    if reach.writes and not reach.cleanup_declared:
        collector.warning(
            "write_without_cleanup",
            f"Feature {document.feature_id!r} writes data and declares no cleanup, so every run "
            "of this scenario leaves data behind",
            ("feature_id",),
        )
    if reach.kind is FeatureKind.read:
        for index, step in enumerate(document.steps):
            if isinstance(step, HttpStep) and step.request.method in WRITE_METHODS:
                collector.warning(
                    "read_feature_writes",
                    f"Feature {document.feature_id!r} is a read feature but the step sends a "
                    f"{step.request.method} request",
                    ("steps", index, "request", "method"),
                )


def normalised_document(document: ScenarioDoc) -> dict[str, Any]:
    return document.model_dump(mode="json", by_alias=True, exclude_none=True)


def document_failure(collector: IssueCollector) -> ScenarioCheck:
    return ScenarioCheck(validation=collector.validation(), document=None, parsed=None)


def report_document_errors(collector: IssueCollector, loaded: LoadedDocument) -> None:
    for problem in loaded.errors:
        if len(collector.errors) >= MAX_REPORTED_ISSUES:
            return
        collector.errors.append(
            ScenarioIssue(
                code=problem.code,
                pointer=problem.pointer,
                line=problem.line,
                column=problem.column,
                message=problem.message,
            )
        )


def oversized(text: str, max_bytes: int) -> ScenarioCheck | None:
    size = len(text.encode("utf-8"))
    if size <= max_bytes:
        return None
    collector = IssueCollector(PointerMap())
    collector.error(
        "scenario_too_large",
        f"The scenario is {size} bytes, the limit is {max_bytes}",
        (),
    )
    return document_failure(collector)


def validate_scenario_text(
    text: str, view: ScenarioBundleView, max_bytes: int = MAX_SCENARIO_BYTES
) -> ScenarioCheck:
    too_large = oversized(text, max_bytes)
    if too_large is not None:
        return too_large
    loaded = load_yaml_document(text, SCENARIO_FILE)
    collector = IssueCollector(loaded.pointers)
    report_document_errors(collector, loaded)
    if loaded.data is None:
        return document_failure(collector)
    try:
        document = ScenarioDoc.model_validate(loaded.data)
    except ValidationError as error:
        collect_model_errors(collector, error, loaded.data)
        return document_failure(collector)
    check_references(collector, view, document)
    check_placeholders(collector, loaded.data, view.environment_names)
    check_built_ins(collector, loaded.data)
    check_lints(collector, view, document)
    validation = collector.validation()
    return ScenarioCheck(
        validation=validation, document=document, parsed=normalised_document(document)
    )
