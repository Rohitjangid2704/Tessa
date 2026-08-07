from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from tessa_api.schemas.bundles import BundleCompleteness, BundleValidationError

ItemKind = Literal["error", "check", "warning"]

NOTHING_TO_FIX_TEXT = "Nothing is open: the bundle has no errors, warnings or missing points."


@dataclass(frozen=True, slots=True)
class FixupItem:
    kind: ItemKind
    location: str
    message: str
    fix_hint: str | None = None


def describe_location(problem: BundleValidationError) -> str:
    parts = [problem.file]
    if problem.pointer:
        parts.append(problem.pointer)
    if problem.line is not None:
        parts.append(f"line {problem.line}")
    return ", ".join(parts)


def problem_item(kind: ItemKind, problem: BundleValidationError) -> FixupItem:
    return FixupItem(
        kind=kind,
        location=describe_location(problem),
        message=f"{problem.code}: {problem.message}",
    )


def build_fixup_items(
    errors: Sequence[Mapping[str, Any]],
    warnings: Sequence[Mapping[str, Any]],
    completeness: Mapping[str, Any],
) -> list[FixupItem]:
    parsed_completeness = BundleCompleteness.model_validate(completeness)
    items = [problem_item("error", BundleValidationError.model_validate(error)) for error in errors]
    missing_points = sorted(
        (check for check in parsed_completeness.checks if check.earned < check.weight),
        key=lambda check: (check.earned - check.weight, check.id),
    )
    items.extend(
        FixupItem(
            kind="check",
            location=f"completeness check {check.id}",
            message=(
                f"{check.label}: {check.earned} of {check.weight} points"
                + (f". {check.detail}" if check.detail else "")
            ),
            fix_hint=check.fix_hint,
        )
        for check in missing_points
    )
    items.extend(
        problem_item("warning", BundleValidationError.model_validate(warning))
        for warning in warnings
    )
    return items


def render_fixup_items(items: Sequence[FixupItem]) -> str:
    if not items:
        return NOTHING_TO_FIX_TEXT
    lines: list[str] = []
    for number, item in enumerate(items, start=1):
        line = f"{number}. [{item.kind}] {item.location}: {item.message}"
        if item.fix_hint:
            line += f"\n   To fix: {item.fix_hint}"
        lines.append(line)
    return "\n".join(lines)
