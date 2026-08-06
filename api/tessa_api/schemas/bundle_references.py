import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError
from pydantic_core import InitErrorDetails, PydanticCustomError

if TYPE_CHECKING:
    from tessa_api.schemas.bundle import BundleManifest

SKIP_REFERENCE_CHECKS = "skip_reference_checks"
STRUCTURE_ONLY_CONTEXT: dict[str, Any] = {SKIP_REFERENCE_CHECKS: True}

PLACEHOLDER_PATTERN = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")
LOOSE_PLACEHOLDER_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

ALL_ROLES = "all"
NO_FLAG = "none"

Location = tuple[str | int, ...]


@dataclass(frozen=True, slots=True)
class ManifestProblem:
    code: str
    message: str
    loc: Location
    value: Any = None


def to_validation_error(title: str, problems: Sequence[ManifestProblem]) -> ValidationError:
    details = [
        InitErrorDetails(
            type=PydanticCustomError(problem.code, "{message}", {"message": problem.message}),
            loc=problem.loc,
            input=problem.value,
        )
        for problem in problems
    ]
    return ValidationError.from_exception_data(title, details)


def duplicate_problems(
    section: Location, identifiers: Sequence[tuple[Location, str]], noun: str
) -> list[ManifestProblem]:
    first_seen: dict[str, Location] = {}
    problems: list[ManifestProblem] = []
    for loc, identifier in identifiers:
        if identifier in first_seen:
            problems.append(
                ManifestProblem(
                    code="duplicate_id",
                    message=(
                        f"The {noun} {identifier!r} is already used at "
                        f"/{'/'.join(str(part) for part in first_seen[identifier])}"
                    ),
                    loc=(*section, *loc),
                    value=identifier,
                )
            )
        else:
            first_seen[identifier] = (*section, *loc)
    return problems


def find_duplicate_ids(manifest: "BundleManifest") -> list[ManifestProblem]:
    problems: list[ManifestProblem] = []
    keyed_sections: tuple[tuple[str, str, Sequence[Any]], ...] = (
        ("interfaces", "interface id", manifest.interfaces),
        ("roles", "role id", manifest.roles),
        ("features", "feature id", manifest.features),
        ("invariants", "invariant id", manifest.invariants),
        ("flags", "flag id", manifest.flags),
        ("truth_sources", "truth source id", manifest.truth_sources),
        ("consumes", "consumed call id", manifest.consumes),
    )
    for section, noun, items in keyed_sections:
        identifiers = [((index, "id"), item.id) for index, item in enumerate(items)]
        problems.extend(duplicate_problems((section,), identifiers, noun))
    environment_names = [
        ((index, "name"), variable.name) for index, variable in enumerate(manifest.environment)
    ]
    problems.extend(duplicate_problems(("environment",), environment_names, "variable name"))
    if manifest.data_model is not None:
        store_names = [
            ((index, "name"), store.name) for index, store in enumerate(manifest.data_model.stores)
        ]
        problems.extend(duplicate_problems(("data_model", "stores"), store_names, "store name"))
    if manifest.test_hooks is not None:
        hook_ids = [
            ((group, index, "id"), hook.id)
            for group, hooks in (
                ("available", manifest.test_hooks.available),
                ("missing", manifest.test_hooks.missing),
            )
            for index, hook in enumerate(hooks)
        ]
        problems.extend(duplicate_problems(("test_hooks",), hook_ids, "hook id"))
    return problems


def find_unknown_references(manifest: "BundleManifest") -> list[ManifestProblem]:
    interface_ids = {interface.id for interface in manifest.interfaces}
    role_ids = {role.id for role in manifest.roles} | {ALL_ROLES}
    flag_ids = {flag.id for flag in manifest.flags} | {NO_FLAG}
    variable_names = {variable.name for variable in manifest.environment}
    problems: list[ManifestProblem] = []

    for feature_index, feature in enumerate(manifest.features):
        for position, interface_id in enumerate(feature.interfaces):
            if interface_id not in interface_ids:
                problems.append(
                    ManifestProblem(
                        code="unknown_interface",
                        message=f"Feature {feature.id!r} uses interface {interface_id!r}, "
                        "which is not declared in interfaces",
                        loc=("features", feature_index, "interfaces", position),
                        value=interface_id,
                    )
                )
        for position, role_id in enumerate(feature.roles):
            if role_id not in role_ids:
                problems.append(
                    ManifestProblem(
                        code="unknown_role",
                        message=f"Feature {feature.id!r} uses role {role_id!r}, which is not "
                        f"declared in roles (use {ALL_ROLES!r} for every role)",
                        loc=("features", feature_index, "roles", position),
                        value=role_id,
                    )
                )
        if feature.flag not in flag_ids:
            problems.append(
                ManifestProblem(
                    code="unknown_flag",
                    message=f"Feature {feature.id!r} uses flag {feature.flag!r}, which is not "
                    f"declared in flags (use {NO_FLAG!r} when no flag applies)",
                    loc=("features", feature_index, "flag"),
                    value=feature.flag,
                )
            )

    for variable_index, variable in enumerate(manifest.environment):
        for position, interface_id in enumerate(variable.interfaces):
            if interface_id not in interface_ids:
                problems.append(
                    ManifestProblem(
                        code="unknown_interface",
                        message=f"Variable {variable.name!r} belongs to interface "
                        f"{interface_id!r}, which is not declared in interfaces",
                        loc=("environment", variable_index, "interfaces", position),
                        value=interface_id,
                    )
                )

    def undeclared_variable(loc: Location, owner: str, name: str) -> ManifestProblem:
        return ManifestProblem(
            code="unknown_environment_variable",
            message=f"{owner} names variable {name!r}, which is not declared in environment",
            loc=loc,
            value=name,
        )

    for interface_index, interface in enumerate(manifest.interfaces):
        secret_env = None if interface.auth is None else interface.auth.secret_env
        if secret_env is not None and secret_env not in variable_names:
            problems.append(
                undeclared_variable(
                    ("interfaces", interface_index, "auth", "secret_env"),
                    f"Interface {interface.id!r}",
                    secret_env,
                )
            )
    for role_index, role in enumerate(manifest.roles):
        if role.credential_env is not None and role.credential_env not in variable_names:
            problems.append(
                undeclared_variable(
                    ("roles", role_index, "credential_env"),
                    f"Role {role.id!r}",
                    role.credential_env,
                )
            )
    truth_variables: set[str] = set()
    for source_index, source in enumerate(manifest.truth_sources):
        truth_variables.add(source.connection_env)
        if source.connection_env not in variable_names:
            problems.append(
                undeclared_variable(
                    ("truth_sources", source_index, "connection_env"),
                    f"Truth source {source.id!r}",
                    source.connection_env,
                )
            )
    if manifest.seeds is not None and manifest.seeds.dsn_env is not None:
        dsn_env = manifest.seeds.dsn_env
        if dsn_env not in variable_names:
            problems.append(undeclared_variable(("seeds", "dsn_env"), "Seeds", dsn_env))
        if dsn_env in truth_variables:
            problems.append(
                ManifestProblem(
                    code="seed_dsn_shared_with_truth",
                    message=f"The seed connection {dsn_env!r} is also a truth source connection; "
                    "seeds write, truth sources are read-only, so they need separate variables",
                    loc=("seeds", "dsn_env"),
                    value=dsn_env,
                )
            )
    return problems


def walk_strings(node: Any, loc: Location) -> Iterator[tuple[Location, str]]:
    if isinstance(node, str):
        yield loc, node
    elif isinstance(node, Mapping):
        for key, value in node.items():
            yield from walk_strings(value, (*loc, str(key)))
    elif isinstance(node, Sequence):
        for index, value in enumerate(node):
            yield from walk_strings(value, (*loc, index))


def find_placeholder_problems(manifest: "BundleManifest") -> list[ManifestProblem]:
    declared = {variable.name for variable in manifest.environment}
    document = manifest.model_dump(mode="json", by_alias=True)
    problems: list[ManifestProblem] = []
    for loc, text in walk_strings(document, ()):
        for match in LOOSE_PLACEHOLDER_PATTERN.finditer(text):
            name = match.group(1)
            if PLACEHOLDER_PATTERN.fullmatch(match.group(0)) is None:
                problems.append(
                    ManifestProblem(
                        code="invalid_placeholder",
                        message=f"Placeholder ${{{name}}} must use upper case letters, digits "
                        "and underscores and start with a letter, for example ${BASE_URL}",
                        loc=loc,
                        value=match.group(0),
                    )
                )
            elif name not in declared:
                problems.append(
                    ManifestProblem(
                        code="undeclared_placeholder",
                        message=f"Placeholder ${{{name}}} is not declared in environment; "
                        "declare it, or drop the braces if it is not a Tessa placeholder",
                        loc=loc,
                        value=match.group(0),
                    )
                )
    return problems


def find_reference_problems(manifest: "BundleManifest") -> list[ManifestProblem]:
    return [
        *find_duplicate_ids(manifest),
        *find_unknown_references(manifest),
        *find_placeholder_problems(manifest),
    ]
