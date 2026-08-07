from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from tessa_api.schemas.bundles import BundleCompleteness, BundleCompletenessCheck
from tessa_api.schemas.enums import BundleCompletenessStatus
from tessa_api.services.bundle_validator import BundleAnalysis

REQUIRED_SECTIONS: tuple[tuple[str, type], ...] = (
    ("schema", str),
    ("target_token", str),
    ("app", dict),
    ("interfaces", list),
    ("roles", list),
    ("features", list),
    ("environment", list),
)
URL_INTERFACE_KINDS = frozenset({"http", "sse", "browser", "graphql", "websocket"})
ABSOLUTE_URL_PREFIXES = ("http://", "https://", "ws://", "wss://")
RESET_SCRIPT_POINTS = 8
HASH_COMMAND_POINTS = 7
MAX_NAMED_IN_HINT = 5
PASTE_DETAIL = (
    "A pasted manifest has no sibling files, so this check cannot be earned; upload the zip of the "
    "tessa folder"
)


@dataclass(frozen=True)
class CheckSpec:
    id: str
    label: str
    weight: int


CHECK_SPECS: tuple[CheckSpec, ...] = (
    CheckSpec("required_sections", "Required manifest sections are present", 20),
    CheckSpec("feature_interface_roles", "Every feature names its interfaces and roles", 15),
    CheckSpec("feature_examples", "Every feature has a concrete example", 20),
    CheckSpec("oracle_read_only", "Every oracle parses and is a read-only query", 15),
    CheckSpec("env_template_coverage", "env.template covers every interface and truth source", 15),
    CheckSpec("seeds_reset_and_hash", "Seeds have a reset script and a hash command", 15),
)
TOTAL_WEIGHT = sum(spec.weight for spec in CHECK_SPECS)


def proportional_points(weight: int, satisfied: int, total: int) -> int:
    if total <= 0 or satisfied <= 0:
        return 0
    if satisfied >= total:
        return weight
    rounded = (weight * satisfied * 2 + total) // (2 * total)
    return min(weight - 1, rounded)


def named(items: Sequence[str]) -> str:
    shown = ", ".join(items[:MAX_NAMED_IN_HINT])
    extra = len(items) - MAX_NAMED_IN_HINT
    return f"{shown} and {extra} more" if extra > 0 else shown


def build_check(
    spec: CheckSpec, earned: int, detail: str | None, fix_hint: str | None
) -> BundleCompletenessCheck:
    passed = earned == spec.weight
    return BundleCompletenessCheck(
        id=spec.id,
        label=spec.label,
        passed=passed,
        weight=spec.weight,
        earned=earned,
        detail=detail,
        fix_hint=None if passed else fix_hint or f"Fix {spec.label.lower()}",
    )


def dict_items(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, Mapping)]


def non_empty_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def feature_label(feature: Mapping[str, Any], position: int) -> str:
    identifier = feature.get("id")
    return identifier if isinstance(identifier, str) and identifier else f"features[{position}]"


def raw_features(data: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    return [
        (feature_label(feature, position), feature)
        for position, feature in enumerate(dict_items(data.get("features")))
    ]


def score_required_sections(spec: CheckSpec, data: Mapping[str, Any]) -> BundleCompletenessCheck:
    missing = [
        name
        for name, expected_type in REQUIRED_SECTIONS
        if not isinstance(data.get(name), expected_type) or not data.get(name)
    ]
    present = len(REQUIRED_SECTIONS) - len(missing)
    earned = proportional_points(spec.weight, present, len(REQUIRED_SECTIONS))
    detail = f"{present} of {len(REQUIRED_SECTIONS)} required sections are present"
    hint = f"Add or fill the missing top-level section(s) of manifest.yaml: {', '.join(missing)}"
    return build_check(spec, earned, detail, hint)


def score_feature_interface_roles(
    spec: CheckSpec, data: Mapping[str, Any]
) -> BundleCompletenessCheck:
    features = raw_features(data)
    incomplete = [
        label
        for label, feature in features
        if not non_empty_strings(feature.get("interfaces"))
        or not non_empty_strings(feature.get("roles"))
    ]
    satisfied = len(features) - len(incomplete)
    earned = proportional_points(spec.weight, satisfied, len(features))
    if not features:
        return build_check(
            spec,
            0,
            "The manifest lists no features",
            "Add the features of the app under features, each with interfaces and roles",
        )
    detail = f"{satisfied} of {len(features)} features name at least one interface and one role"
    hint = (
        "Give each of these features at least one interface id and one role id (or all): "
        f"{named(incomplete)}"
    )
    return build_check(spec, earned, detail, hint)


def has_example_with_expectation(feature: Mapping[str, Any]) -> bool:
    return any(
        isinstance(example.get("expected"), str) and example["expected"].strip()
        for example in dict_items(feature.get("examples"))
    )


def score_feature_examples(spec: CheckSpec, data: Mapping[str, Any]) -> BundleCompletenessCheck:
    features = raw_features(data)
    lacking = [label for label, feature in features if not has_example_with_expectation(feature)]
    satisfied = len(features) - len(lacking)
    earned = proportional_points(spec.weight, satisfied, len(features))
    if not features:
        return build_check(
            spec,
            0,
            "The manifest lists no features",
            "Add the features of the app, each with at least one example",
        )
    detail = f"{satisfied} of {len(features)} features have an example with an expected behaviour"
    hint = (
        "Add at least one concrete example, with a non-empty `expected`, to each of these "
        f"features: {named(lacking)}"
    )
    return build_check(spec, earned, detail, hint)


def score_oracles(spec: CheckSpec, analysis: BundleAnalysis) -> BundleCompletenessCheck:
    if not analysis.files_available:
        return build_check(
            spec, 0, PASTE_DETAIL, "Upload the zip of the tessa folder with its oracle/ files"
        )
    oracles = list(analysis.oracles.values())
    if not oracles:
        return build_check(
            spec,
            0,
            "The bundle has no oracle files",
            "Add oracle/<name>.sql (or .py) with an oracle/<name>.yaml sidecar for every feature "
            "whose expected result can be computed from the app's data, and cite it in the "
            "feature example as `oracle: <name>`",
        )
    failing = [oracle for oracle in oracles if not oracle.ok]
    satisfied = len(oracles) - len(failing)
    earned = proportional_points(spec.weight, satisfied, len(oracles))
    detail = f"{satisfied} of {len(oracles)} oracles parse and are read-only"
    problems = "; ".join(
        f"{oracle.name}: {oracle.reasons[0]}" if oracle.reasons else oracle.name
        for oracle in failing[:MAX_NAMED_IN_HINT]
    )
    hint = f"Fix these oracles so each is one read-only SELECT with a valid sidecar: {problems}"
    return build_check(spec, earned, detail, hint)


def interface_is_covered(
    interface: Mapping[str, Any],
    url_variables: Mapping[str, Sequence[str]],
    template_names: frozenset[str],
) -> bool:
    base_path = interface.get("base_path")
    if isinstance(base_path, str) and base_path.lower().startswith(ABSOLUTE_URL_PREFIXES):
        return True
    identifier = interface.get("id")
    return any(
        name in template_names
        for name, linked in url_variables.items()
        if isinstance(identifier, str) and identifier in linked
    )


def url_variables_of(data: Mapping[str, Any]) -> dict[str, list[str]]:
    return {
        str(variable.get("name")): non_empty_strings(variable.get("interfaces"))
        for variable in dict_items(data.get("environment"))
        if variable.get("kind") == "url" and isinstance(variable.get("name"), str)
    }


def score_env_template(spec: CheckSpec, analysis: BundleAnalysis) -> BundleCompletenessCheck:
    data = analysis.data or {}
    if not analysis.files_available:
        return build_check(
            spec, 0, PASTE_DETAIL, "Upload the zip of the tessa folder with its env.template"
        )
    if analysis.env_template is None:
        return build_check(
            spec,
            0,
            "The bundle has no env.template",
            "Add env.template with one NAME=placeholder line per variable, with a url variable "
            "for every interface and the connection variable of every truth source",
        )
    template_names = analysis.env_template.names
    url_variables = url_variables_of(data)
    wanted: list[tuple[str, bool, str]] = []
    for interface in dict_items(data.get("interfaces")):
        if interface.get("kind") not in URL_INTERFACE_KINDS:
            continue
        label = f"interface {interface.get('id')}"
        covered = interface_is_covered(interface, url_variables, template_names)
        wanted.append((label, covered, "a `kind: url` variable listing it in `interfaces`"))
    for source in dict_items(data.get("truth_sources")):
        variable = source.get("connection_env")
        covered = isinstance(variable, str) and variable in template_names
        wanted.append(
            (
                f"truth source {source.get('id')}",
                covered,
                f"the variable {variable or 'for its connection'}",
            )
        )
    uncovered = [(label, need) for label, covered, need in wanted if not covered]
    satisfied = len(wanted) - len(uncovered)
    earned = spec.weight if not wanted else proportional_points(spec.weight, satisfied, len(wanted))
    detail = (
        f"{satisfied} of {len(wanted)} interfaces and truth sources are covered by env.template"
        if wanted
        else "There are no interfaces or truth sources that need a variable"
    )
    hint = "Add to env.template and to the manifest environment: " + "; ".join(
        f"{label} needs {need}" for label, need in uncovered[:MAX_NAMED_IN_HINT]
    )
    return build_check(spec, earned, detail, hint)


def score_seeds(
    spec: CheckSpec, analysis: BundleAnalysis, file_paths: frozenset[str]
) -> BundleCompletenessCheck:
    if not analysis.files_available:
        return build_check(
            spec, 0, PASTE_DETAIL, "Upload the zip of the tessa folder with its seeds/ files"
        )
    seeds = (analysis.data or {}).get("seeds")
    seeds = seeds if isinstance(seeds, Mapping) else {}
    reset_script = seeds.get("reset_script")
    hash_command = seeds.get("hash_command")
    has_reset = isinstance(reset_script, str) and reset_script in file_paths
    has_hash = isinstance(hash_command, str) and bool(hash_command.strip())
    earned = (RESET_SCRIPT_POINTS if has_reset else 0) + (HASH_COMMAND_POINTS if has_hash else 0)
    missing: list[str] = []
    if not has_reset:
        missing.append(
            "seeds.reset_script naming a script under seeds/ (.sql, .py or .sh) that is in the "
            "bundle and restores the QA tenant to the same state on every run"
        )
    if not has_hash:
        missing.append(
            "seeds.hash_command, one command line that prints a hash of the seeded state as its "
            "last line"
        )
    detail = (
        f"Reset script {'found' if has_reset else 'missing'}, "
        f"hash command {'declared' if has_hash else 'missing'}"
    )
    return build_check(spec, earned, detail, "Add " + " and ".join(missing))


def score_bundle(analysis: BundleAnalysis, bar: int) -> BundleCompleteness:
    data = analysis.data or {}
    scorers: dict[str, Callable[[CheckSpec], BundleCompletenessCheck]] = {
        "required_sections": lambda spec: score_required_sections(spec, data),
        "feature_interface_roles": lambda spec: score_feature_interface_roles(spec, data),
        "feature_examples": lambda spec: score_feature_examples(spec, data),
        "oracle_read_only": lambda spec: score_oracles(spec, analysis),
        "env_template_coverage": lambda spec: score_env_template(spec, analysis),
        "seeds_reset_and_hash": lambda spec: score_seeds(spec, analysis, analysis.file_paths),
    }
    checks = [scorers[spec.id](spec) for spec in CHECK_SPECS]
    score = sum(check.earned for check in checks)
    status = (
        BundleCompletenessStatus.meets_bar if score >= bar else BundleCompletenessStatus.below_bar
    )
    return BundleCompleteness(score=score, bar=bar, status=status, checks=checks)
