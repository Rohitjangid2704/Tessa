from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import JsonValue

from tessa_api.schemas.bundle_references import walk_strings
from tessa_api.schemas.enums import OracleApproval
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.services.gold_interpolation import gold_keys_in_text, malformed_gold_references
from tessa_api.services.oracle_params import automatic_parameters, validate_oracle_params

Location = tuple[str | int, ...]
Severity = Literal["error", "warning"]

GOLD_ALLOWED_LOCATIONS: tuple[Location, ...] = (
    ("expect", "text_contains"),
    ("expect", "text_contains_any"),
    ("expect", "dom_state", "text_contains"),
    ("expect", "fields"),
    ("expect_db", "expect"),
)
GOLD_ALLOWED_WHERE = "text_contains, fields and expect_db.expect"


@dataclass(frozen=True, slots=True)
class OracleView:
    name: str
    approval: OracleApproval
    params_schema: Mapping[str, Any]
    gold_keys: frozenset[str]


@dataclass(frozen=True, slots=True)
class TruthIssue:
    severity: Severity
    code: str
    message: str
    loc: Location


def location_allows_gold(relative: Location) -> bool:
    return any(relative[: len(allowed)] == allowed for allowed in GOLD_ALLOWED_LOCATIONS)


def oracle_issues(
    name: str,
    params: Mapping[str, JsonValue],
    base: Location,
    oracles: Mapping[str, OracleView],
) -> tuple[OracleView | None, list[TruthIssue]]:
    oracle = oracles.get(name)
    if oracle is None:
        return None, [
            TruthIssue(
                "error",
                "unknown_oracle",
                f"Oracle {name!r} is not an oracle of this bundle",
                (*base, "oracle"),
            )
        ]
    issues: list[TruthIssue] = []
    if oracle.approval is not OracleApproval.approved:
        issues.append(
            TruthIssue(
                "warning",
                "oracle_not_approved",
                f"Oracle {name!r} is {oracle.approval.value}; scenarios that use it are skipped "
                "with precondition_failed until it is approved",
                (*base, "oracle"),
            )
        )
    schema = oracle.params_schema
    for problem in validate_oracle_params(schema, params, automatic_parameters(schema)):
        issues.append(
            TruthIssue(
                "error",
                "oracle_params_invalid",
                f"Parameters of oracle {name!r}: {problem.message}",
                (*base, "params", *problem.loc),
            )
        )
    return oracle, issues


def reference_issues(
    step_document: Mapping[str, Any], base: Location, available: frozenset[str]
) -> list[TruthIssue]:
    issues: list[TruthIssue] = []
    for relative, text in walk_strings(step_document, ()):
        loc = (*base, *relative)
        issues.extend(
            TruthIssue(
                "error",
                "invalid_gold_reference",
                f"{reference} is not a valid gold reference; write ${{gold.<key>}} with a key in "
                "lower case letters, digits and underscores",
                loc,
            )
            for reference in malformed_gold_references(text)
        )
        for key in gold_keys_in_text(text):
            if not location_allows_gold(relative):
                issues.append(
                    TruthIssue(
                        "error",
                        "gold_reference_not_allowed",
                        f"${{gold.{key}}} is only allowed in {GOLD_ALLOWED_WHERE}",
                        loc,
                    )
                )
            elif key not in available:
                issues.append(
                    TruthIssue(
                        "error",
                        "unknown_gold_key",
                        f"No gold_from at or before this step provides a gold point named {key!r}",
                        loc,
                    )
                )
    return issues


def check_truth_references(
    document: ScenarioDoc, oracles: Mapping[str, OracleView]
) -> list[TruthIssue]:
    issues: list[TruthIssue] = []
    available: frozenset[str] = frozenset()
    for index, step in enumerate(document.steps):
        base: Location = ("steps", index)
        if step.gold_from is not None:
            oracle, found = oracle_issues(
                step.gold_from.oracle, step.gold_from.params, (*base, "gold_from"), oracles
            )
            issues.extend(found)
            if oracle is not None:
                available = available | oracle.gold_keys
        if step.expect_db is not None:
            _, found = oracle_issues(
                step.expect_db.oracle, step.expect_db.params, (*base, "expect_db"), oracles
            )
            issues.extend(found)
        step_document = step.model_dump(mode="json", by_alias=True, exclude_none=True)
        issues.extend(reference_issues(step_document, base, available))
    return issues
