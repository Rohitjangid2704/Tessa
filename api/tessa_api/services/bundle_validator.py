import json
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import ValidationError

from tessa_api.schemas.bundle import (
    BundleManifest,
    EnvironmentVariable,
    Feature,
    Interface,
    TruthSource,
)
from tessa_api.schemas.bundle_files import Flow, OracleSidecar
from tessa_api.schemas.bundle_references import PLACEHOLDER_PATTERN, ManifestProblem
from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.schemas.enums import AdapterKind, EnvVarKind
from tessa_api.services.env_template import (
    ParsedEnvTemplate,
    example_has_credentials,
    example_has_path,
    parse_env_template,
)
from tessa_api.services.flow_lint import lint_flow
from tessa_api.services.manifest_loader import (
    MANIFEST_FILE,
    LoadedDocument,
    LoadedManifest,
    PointerMap,
    load_yaml_document,
    to_pointer,
)
from tessa_api.services.oracle_lint import (
    PYTHON_LANGUAGE,
    SQL_LANGUAGE,
    OracleLint,
    lint_python_oracle,
    lint_sql_oracle,
)

Severity = Literal["error", "warning"]

ENV_TEMPLATE_FILE = "env.template"
README_FILE = "README.md"
OPENAPI_FILE = "openapi.json"
ORACLE_FOLDER = "oracle"
FLOWS_FOLDER = "flows"
YAML_SUFFIXES = (".yaml", ".yml")
SOURCE_SUFFIXES = {SQL_LANGUAGE: ".sql", PYTHON_LANGUAGE: ".py"}
URL_KINDS_NEEDING_VARIABLE = frozenset(
    {
        AdapterKind.http,
        AdapterKind.sse,
        AdapterKind.browser,
        AdapterKind.graphql,
        AdapterKind.websocket,
    }
)
MAX_REPORTED_PROBLEMS = 100
TOTAL_PARSE_FACTOR = 4
STRICT_PLACEHOLDER = re.compile(PLACEHOLDER_PATTERN.pattern)
STRUCTURED_FILE_PATTERN = re.compile(r"^(?:flows/.+\.ya?ml|oracle/.+\.ya?ml)$")


@dataclass
class OracleAnalysis:
    name: str
    cited_by: list[str] = field(default_factory=list)
    sidecar_file: str | None = None
    source_file: str | None = None
    reasons: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.reasons


@dataclass
class BundleAnalysis:
    data: dict[str, Any] | None
    manifest: BundleManifest | None
    files_available: bool
    file_paths: frozenset[str]
    errors: list[BundleValidationError] = field(default_factory=list)
    warnings: list[BundleValidationError] = field(default_factory=list)
    env_template: ParsedEnvTemplate | None = None
    oracles: dict[str, OracleAnalysis] = field(default_factory=dict)
    flow_count: int = 0

    @property
    def valid(self) -> bool:
        return not self.errors and self.manifest is not None


@dataclass(frozen=True)
class ManifestView:
    feature_ids: frozenset[str]
    role_ids: frozenset[str]
    environment: Mapping[str, EnvironmentVariable]
    truth_sources: Mapping[str, TruthSource]
    cited_oracles: Mapping[str, list[tuple[str, tuple[str | int, ...]]]]
    features: Sequence[Feature]
    interfaces: Sequence[Interface]


def build_view(manifest: BundleManifest) -> ManifestView:
    cited: dict[str, list[tuple[str, tuple[str | int, ...]]]] = defaultdict(list)
    for feature_index, feature in enumerate(manifest.features):
        for example_index, example in enumerate(feature.examples):
            if example.oracle:
                loc = ("features", feature_index, "examples", example_index, "oracle")
                cited[example.oracle].append((feature.id, loc))
    return ManifestView(
        feature_ids=frozenset(feature.id for feature in manifest.features),
        role_ids=frozenset(role.id for role in manifest.roles),
        environment={variable.name: variable for variable in manifest.environment},
        truth_sources={source.id: source for source in manifest.truth_sources},
        cited_oracles=cited,
        features=manifest.features,
        interfaces=manifest.interfaces,
    )


@dataclass
class ParseBudget:
    per_file_bytes: int
    remaining_bytes: int


class Reporter:
    def __init__(self, budget: ParseBudget) -> None:
        self.errors: list[BundleValidationError] = []
        self.warnings: list[BundleValidationError] = []
        self.budget = budget

    def add(
        self,
        severity: Severity,
        code: str,
        message: str,
        file: str,
        pointer: str | None = None,
        line: int | None = None,
        column: int | None = None,
    ) -> None:
        target = self.errors if severity == "error" else self.warnings
        target.append(
            BundleValidationError(
                code=code,
                message=message,
                severity=severity,
                file=file,
                pointer=pointer,
                line=line,
                column=column,
            )
        )

    def add_at(
        self,
        severity: Severity,
        code: str,
        message: str,
        file: str,
        pointers: PointerMap,
        loc: Sequence[str | int],
    ) -> None:
        pointer = to_pointer(loc)
        found = pointers.locate(pointer)
        self.add(
            severity,
            code,
            message,
            file,
            pointer,
            found[0] if found else None,
            found[1] if found else None,
        )

    def add_problem(
        self, severity: Severity, problem: ManifestProblem, file: str, pointers: PointerMap
    ) -> None:
        self.add_at(severity, problem.code, problem.message, file, pointers, problem.loc)


def report_validation_error(
    reporter: Reporter, error: ValidationError, file: str, pointers: PointerMap
) -> None:
    for item in error.errors():
        loc = tuple(item["loc"])
        reporter.add_at("error", str(item["type"]), str(item["msg"]), file, pointers, loc)


def text_of(files: Mapping[str, bytes], path: str) -> str:
    return files[path].decode("utf-8", errors="replace")


def parseable_text(reporter: Reporter, files: Mapping[str, bytes], path: str) -> str | None:
    size = len(files[path])
    budget = reporter.budget
    if size > budget.per_file_bytes:
        reporter.add(
            "error",
            "file_too_large_to_check",
            f"{path} is {size} bytes; Tessa reads files of this kind up to "
            f"{budget.per_file_bytes} bytes",
            path,
        )
        return None
    if size > budget.remaining_bytes:
        reporter.add(
            "error",
            "bundle_too_large_to_check",
            f"The structured files of the bundle are too large to check in one upload; {path} "
            "was not read",
            path,
        )
        return None
    budget.remaining_bytes -= size
    return text_of(files, path)


def check_environment_template(
    reporter: Reporter,
    files: Mapping[str, bytes],
    view: ManifestView | None,
) -> ParsedEnvTemplate | None:
    if ENV_TEMPLATE_FILE not in files:
        reporter.add(
            "warning",
            "env_template_missing",
            "The bundle has no env.template; list every variable Tessa needs there",
            ENV_TEMPLATE_FILE,
        )
        return None
    parsed = parse_env_template(text_of(files, ENV_TEMPLATE_FILE))
    reporter.errors.extend(parsed.errors)
    reporter.warnings.extend(parsed.warnings)
    if view is None:
        return parsed
    for index, name in enumerate(view.environment):
        if name not in parsed.entries:
            reporter.add(
                "warning",
                "env_template_missing_variable",
                f"Variable {name} is declared in the manifest environment but has no line in "
                "env.template",
                MANIFEST_FILE,
                f"/environment/{index}",
            )
    for name, entry in parsed.entries.items():
        variable = view.environment.get(name)
        if variable is None:
            reporter.add(
                "warning",
                "env_template_unknown_variable",
                f"Variable {name} is in env.template but not declared in the manifest environment",
                ENV_TEMPLATE_FILE,
                line=entry.line,
            )
            continue
        if variable.kind is EnvVarKind.url and example_has_credentials(entry.example):
            reporter.add(
                "error",
                "url_with_credentials",
                f"The example for {name} carries a user name or password inside the URL; "
                "credentials belong in their own secret variables",
                ENV_TEMPLATE_FILE,
                line=entry.line,
            )
        elif variable.kind is EnvVarKind.url and example_has_path(entry.example):
            reporter.add(
                "warning",
                "url_example_has_path",
                f"The example for {name} has a path; the variable is the origin only and the "
                "interface base_path is appended to it",
                ENV_TEMPLATE_FILE,
                line=entry.line,
            )
    return parsed


def check_interface_variables(reporter: Reporter, view: ManifestView) -> None:
    for index, interface in enumerate(view.interfaces):
        if interface.kind not in URL_KINDS_NEEDING_VARIABLE:
            continue
        if interface.base_path.lower().startswith(("http://", "https://", "ws://", "wss://")):
            continue
        linked = [
            variable
            for variable in view.environment.values()
            if variable.kind is EnvVarKind.url and interface.id in variable.interfaces
        ]
        if not linked:
            reporter.add(
                "warning",
                "interface_without_url_variable",
                f"Interface {interface.id!r} has no variable of kind url that lists it in "
                "interfaces, so Tessa cannot tell where to reach it",
                MANIFEST_FILE,
                f"/interfaces/{index}",
            )


def check_seed_files(
    reporter: Reporter, manifest: BundleManifest, file_paths: frozenset[str]
) -> None:
    seeds = manifest.seeds
    if seeds is None:
        return
    if seeds.reset_script is not None and seeds.reset_script not in file_paths:
        reporter.add(
            "error",
            "seed_file_missing",
            f"seeds.reset_script points at {seeds.reset_script}, which is not in the bundle",
            MANIFEST_FILE,
            "/seeds/reset_script",
        )
    for index, fixture in enumerate(seeds.fixtures):
        if fixture not in file_paths:
            reporter.add(
                "error",
                "seed_file_missing",
                f"seeds.fixtures lists {fixture}, which is not in the bundle",
                MANIFEST_FILE,
                f"/seeds/fixtures/{index}",
            )


def oracle_names_in(file_paths: frozenset[str]) -> dict[str, dict[str, str]]:
    found: dict[str, dict[str, str]] = defaultdict(dict)
    prefix = f"{ORACLE_FOLDER}/"
    for path in sorted(file_paths):
        if not path.startswith(prefix) or "/" in path[len(prefix) :]:
            continue
        stem, dot, suffix = path[len(prefix) :].rpartition(".")
        if not dot or not stem:
            continue
        extension = f".{suffix}"
        if extension in YAML_SUFFIXES:
            found[stem].setdefault("sidecar", path)
        elif extension == SOURCE_SUFFIXES[SQL_LANGUAGE]:
            found[stem]["sql"] = path
        elif extension == SOURCE_SUFFIXES[PYTHON_LANGUAGE]:
            found[stem]["python"] = path
    return found


def check_oracle_sidecar(
    reporter: Reporter,
    name: str,
    sidecar_path: str,
    document: LoadedDocument,
    view: ManifestView | None,
) -> OracleSidecar | None:
    try:
        sidecar = OracleSidecar.model_validate(document.data)
    except ValidationError as error:
        report_validation_error(reporter, error, sidecar_path, document.pointers)
        return None
    if sidecar.name != name:
        reporter.add_at(
            "error",
            "oracle_name_mismatch",
            f"The oracle name {sidecar.name!r} must equal its file name {name!r}",
            sidecar_path,
            document.pointers,
            ("name",),
        )
    if view is None:
        return sidecar
    for position, feature_id in enumerate(sidecar.feature_ids):
        if feature_id not in view.feature_ids:
            reporter.add_at(
                "error",
                "unknown_feature",
                f"Oracle {name} cites feature {feature_id!r}, which the manifest does not declare",
                sidecar_path,
                document.pointers,
                ("feature_ids", position),
            )
    return sidecar


def resolve_truth_source(
    reporter: Reporter,
    sidecar: OracleSidecar,
    sidecar_path: str,
    pointers: PointerMap,
    view: ManifestView,
) -> TruthSource | None:
    if sidecar.truth_source is not None:
        source = view.truth_sources.get(sidecar.truth_source)
        if source is None:
            reporter.add_at(
                "error",
                "unknown_truth_source",
                f"Oracle {sidecar.name} runs on truth source {sidecar.truth_source!r}, which the "
                "manifest does not declare",
                sidecar_path,
                pointers,
                ("truth_source",),
            )
        return source
    if len(view.truth_sources) == 1:
        return next(iter(view.truth_sources.values()))
    reporter.add_at(
        "error",
        "truth_source_required",
        f"Oracle {sidecar.name} must name its truth_source: the manifest declares "
        f"{len(view.truth_sources)} truth sources",
        sidecar_path,
        pointers,
        ("truth_source",),
    )
    return None


def lint_oracle_source(
    reporter: Reporter,
    sidecar: OracleSidecar,
    sidecar_path: str,
    source_path: str,
    source_text: str,
    document: LoadedDocument,
    source: TruthSource | None,
    view: ManifestView | None,
) -> OracleLint:
    if sidecar.language == PYTHON_LANGUAGE:
        return lint_python_oracle(source_text)
    if view is None or source is None:
        return OracleLint()
    if source.kind != "database":
        reporter.add_at(
            "error",
            "oracle_source_not_database",
            f"Oracle {sidecar.name} is SQL but truth source {source.id!r} is a read endpoint",
            sidecar_path,
            document.pointers,
            ("truth_source",),
        )
        return OracleLint()
    lint = lint_sql_oracle(source_text, source.dialect)
    declared = set(_declared_parameters(sidecar))
    for parameter in sorted(lint.parameters - declared):
        reporter.add(
            "error",
            "oracle_param_undeclared",
            f"The query uses :{parameter}, which is not declared in params_schema.properties",
            source_path,
        )
    for parameter in sorted(declared - lint.parameters):
        if lint.ok:
            reporter.add_at(
                "warning",
                "oracle_param_unused",
                f"Parameter {parameter!r} is declared in params_schema but the query does not "
                "use it",
                sidecar_path,
                document.pointers,
                ("params_schema", "properties", parameter),
            )
    return lint


def _declared_parameters(sidecar: OracleSidecar) -> list[str]:
    properties = sidecar.params_schema.get("properties", {})
    return [str(name) for name in properties] if isinstance(properties, dict) else []


def check_one_oracle(
    reporter: Reporter,
    analysis: OracleAnalysis,
    paths: Mapping[str, str],
    files: Mapping[str, bytes],
    view: ManifestView | None,
) -> None:
    errors_before = len(reporter.errors)
    sidecar_path = paths.get("sidecar")
    analysis.sidecar_file = sidecar_path
    if sidecar_path is None:
        if not analysis.cited_by:
            reporter.add(
                "warning",
                "oracle_sidecar_missing",
                f"Oracle {analysis.name} has a source file but no oracle/{analysis.name}.yaml "
                "describing its parameters and expected sentence",
                f"{ORACLE_FOLDER}/{analysis.name}.yaml",
            )
        analysis.reasons.append(f"oracle/{analysis.name}.yaml is missing")
        return
    sidecar_text = parseable_text(reporter, files, sidecar_path)
    if sidecar_text is None:
        analysis.reasons.append("its sidecar is too large to check")
        return
    document = load_yaml_document(sidecar_text, sidecar_path)
    reporter.errors.extend(document.errors)
    if document.data is None:
        analysis.reasons.append("its sidecar is not readable YAML")
        return
    sidecar = check_oracle_sidecar(reporter, analysis.name, sidecar_path, document, view)
    if sidecar is None:
        analysis.reasons.append("its sidecar does not match the oracle format")
        return
    source_path = paths.get(sidecar.language)
    expected_name = f"{ORACLE_FOLDER}/{analysis.name}{SOURCE_SUFFIXES[sidecar.language]}"
    if source_path is None:
        reporter.add_at(
            "error",
            "oracle_source_missing",
            f"Oracle {analysis.name} declares language {sidecar.language} but {expected_name} is "
            "not in the bundle",
            sidecar_path,
            document.pointers,
            ("language",),
        )
        analysis.reasons.append(f"{expected_name} is missing")
        return
    analysis.source_file = source_path
    source_text = parseable_text(reporter, files, source_path)
    if source_text is None:
        analysis.reasons.append(f"{source_path} is too large to check")
        return
    truth = (
        resolve_truth_source(reporter, sidecar, sidecar_path, document.pointers, view)
        if view
        else None
    )
    lint = lint_oracle_source(
        reporter,
        sidecar,
        sidecar_path,
        source_path,
        source_text,
        document,
        truth,
        view,
    )
    for problem in lint.problems:
        reporter.add(
            "error", problem.code, problem.message, source_path, line=problem.line, column=None
        )
        analysis.reasons.append(problem.message)
    if view is not None:
        listed = set(sidecar.feature_ids)
        for feature_id in analysis.cited_by:
            if feature_id not in listed:
                reporter.add_at(
                    "warning",
                    "oracle_feature_not_listed",
                    f"Feature {feature_id!r} cites oracle {analysis.name} but the sidecar does "
                    "not list it in feature_ids",
                    sidecar_path,
                    document.pointers,
                    ("feature_ids",),
                )
    if len(reporter.errors) > errors_before and not analysis.reasons:
        analysis.reasons.append("its files have errors")


def check_oracles(
    reporter: Reporter,
    files: Mapping[str, bytes],
    file_paths: frozenset[str],
    view: ManifestView | None,
    manifest_pointers: PointerMap,
) -> dict[str, OracleAnalysis]:
    discovered = oracle_names_in(file_paths)
    names = sorted(set(discovered) | (set(view.cited_oracles) if view else set()))
    analyses: dict[str, OracleAnalysis] = {}
    for name in names:
        analysis = OracleAnalysis(name=name)
        if view is not None:
            analysis.cited_by = [feature_id for feature_id, _ in view.cited_oracles.get(name, [])]
        analyses[name] = analysis
        check_one_oracle(reporter, analysis, discovered.get(name, {}), files, view)
        missing_sidecar = "sidecar" not in discovered.get(name, {})
        if view is not None and name in view.cited_oracles and missing_sidecar:
            for _, loc in view.cited_oracles[name]:
                reporter.add_at(
                    "error",
                    "oracle_file_missing",
                    f"The example cites oracle {name!r} but the bundle has no oracle/{name}.yaml",
                    MANIFEST_FILE,
                    manifest_pointers,
                    loc,
                )
    return analyses


def check_flows(
    reporter: Reporter,
    files: Mapping[str, bytes],
    file_paths: frozenset[str],
    view: ManifestView | None,
) -> int:
    count = 0
    prefix = f"{FLOWS_FOLDER}/"
    for path in sorted(file_paths):
        if not path.startswith(prefix) or "/" in path[len(prefix) :]:
            continue
        stem, _, suffix = path[len(prefix) :].rpartition(".")
        if f".{suffix}" not in YAML_SUFFIXES:
            continue
        count += 1
        flow_text = parseable_text(reporter, files, path)
        if flow_text is None:
            continue
        document = load_yaml_document(flow_text, path)
        reporter.errors.extend(document.errors)
        if document.data is None:
            continue
        try:
            flow = Flow.model_validate(document.data)
        except ValidationError as error:
            report_validation_error(reporter, error, path, document.pointers)
            continue
        if view is None:
            continue
        for problem in lint_flow(
            flow, stem, view.feature_ids, view.role_ids, frozenset(view.environment)
        ):
            reporter.add_problem("error", problem, path, document.pointers)
    return count


def check_placeholders(
    reporter: Reporter,
    files: Mapping[str, bytes],
    view: ManifestView,
    template: ParsedEnvTemplate | None,
) -> None:
    reported: set[tuple[str, str, str]] = set()
    for path in sorted(files):
        if path == ENV_TEMPLATE_FILE:
            continue
        for number, line in enumerate(text_of(files, path).split("\n"), start=1):
            for match in STRICT_PLACEHOLDER.finditer(line):
                name = match.group(1)
                declared = name in view.environment
                if declared and template is not None and name not in template.entries:
                    key = (path, name, "template")
                    if key not in reported:
                        reported.add(key)
                        reporter.add(
                            "error",
                            "placeholder_not_in_env_template",
                            f"Placeholder ${{{name}}} is used but env.template has no line for it",
                            path,
                            line=number,
                            column=match.start() + 1,
                        )
                elif (
                    not declared
                    and path != MANIFEST_FILE
                    and not STRUCTURED_FILE_PATTERN.match(path)
                ):
                    key = (path, name, "declared")
                    if key not in reported:
                        reported.add(key)
                        reporter.add(
                            "warning",
                            "placeholder_not_declared",
                            f"Placeholder ${{{name}}} is not declared in the manifest environment; "
                            "write $NAME in shell snippets if it is not a Tessa placeholder",
                            path,
                            line=number,
                            column=match.start() + 1,
                        )


def check_auxiliary_files(reporter: Reporter, files: Mapping[str, bytes]) -> None:
    if README_FILE not in files:
        reporter.add(
            "warning",
            "readme_missing",
            "The bundle has no README.md for QA engineers",
            README_FILE,
        )
    if OPENAPI_FILE in files:
        try:
            json.loads(text_of(files, OPENAPI_FILE))
        except ValueError as error:
            reporter.add(
                "warning",
                "openapi_unreadable",
                f"openapi.json is not valid JSON: {error}",
                OPENAPI_FILE,
            )


def validate_bundle(
    loaded: LoadedManifest,
    files: Mapping[str, bytes],
    files_available: bool,
    parse_limit_bytes: int,
) -> BundleAnalysis:
    reporter = Reporter(
        ParseBudget(
            per_file_bytes=parse_limit_bytes,
            remaining_bytes=parse_limit_bytes * TOTAL_PARSE_FACTOR,
        )
    )
    reporter.errors.extend(loaded.errors)
    file_paths = frozenset(files)
    analysis = BundleAnalysis(
        data=loaded.data, manifest=None, files_available=files_available, file_paths=file_paths
    )
    if loaded.data is None:
        analysis.errors = reporter.errors
        return analysis
    try:
        manifest = BundleManifest.model_validate(loaded.data)
    except ValidationError as error:
        report_validation_error(reporter, error, MANIFEST_FILE, loaded.pointers)
        manifest = None
    analysis.manifest = manifest
    view = build_view(manifest) if manifest is not None else None
    if files_available:
        analysis.env_template = check_environment_template(reporter, files, view)
        analysis.oracles = check_oracles(reporter, files, file_paths, view, loaded.pointers)
        analysis.flow_count = check_flows(reporter, files, file_paths, view)
        check_auxiliary_files(reporter, files)
        if manifest is not None and view is not None:
            check_seed_files(reporter, manifest, file_paths)
            check_placeholders(reporter, files, view, analysis.env_template)
    if view is not None:
        check_interface_variables(reporter, view)
    analysis.errors = reporter.errors[:MAX_REPORTED_PROBLEMS]
    analysis.warnings = reporter.warnings[:MAX_REPORTED_PROBLEMS]
    return analysis
