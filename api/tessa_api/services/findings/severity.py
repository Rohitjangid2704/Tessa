from collections.abc import Mapping
from enum import StrEnum

from tessa_api.schemas.enums import FeatureKind, FindingClass, Severity

SEVERITY_ORDER: tuple[Severity, ...] = (
    Severity.info,
    Severity.low,
    Severity.medium,
    Severity.high,
    Severity.critical,
)
SEVERITY_RANK: Mapping[Severity, int] = {
    severity: rank for rank, severity in enumerate(SEVERITY_ORDER)
}

BASE_SEVERITY: Mapping[FindingClass, Severity] = {
    FindingClass.security_boundary: Severity.critical,
    FindingClass.server_error: Severity.high,
    FindingClass.safety_claim: Severity.high,
    FindingClass.wrong_result: Severity.high,
    FindingClass.invariant_violation: Severity.medium,
    FindingClass.contract: Severity.medium,
    FindingClass.flaky: Severity.medium,
    FindingClass.harness: Severity.medium,
    FindingClass.performance: Severity.low,
    FindingClass.accessibility: Severity.low,
}
KIND_ESCALATION: Mapping[FeatureKind, int] = {
    FeatureKind.write: 1,
    FeatureKind.admin: 1,
    FeatureKind.auth: 1,
    FeatureKind.job: 1,
    FeatureKind.flow: 1,
    FeatureKind.read: 0,
    FeatureKind.stream: 0,
}
ESCALATED_CLASSES = frozenset(
    {
        FindingClass.wrong_result,
        FindingClass.server_error,
        FindingClass.safety_claim,
        FindingClass.invariant_violation,
    }
)
RELIEVED_CLASSES = frozenset(
    {
        FindingClass.wrong_result,
        FindingClass.invariant_violation,
        FindingClass.performance,
        FindingClass.accessibility,
        FindingClass.contract,
    }
)
ROLE_RELIEF_STEPS = 1


class RoleStanding(StrEnum):
    unknown = "unknown"
    only = "only"
    lowest = "lowest"
    middle = "middle"
    highest = "highest"


def role_standing(levels: Mapping[str, int], role: str | None) -> RoleStanding:
    if role is None or role not in levels:
        return RoleStanding.unknown
    distinct = set(levels.values())
    if len(distinct) == 1:
        return RoleStanding.only
    level = levels[role]
    if level == max(distinct):
        return RoleStanding.highest
    if level == min(distinct):
        return RoleStanding.lowest
    return RoleStanding.middle


def shifted(severity: Severity, steps: int) -> Severity:
    rank = min(max(SEVERITY_RANK[severity] + steps, 0), len(SEVERITY_ORDER) - 1)
    return SEVERITY_ORDER[rank]


def severity_for(
    finding_class: FindingClass, feature_kind: FeatureKind | None, standing: RoleStanding
) -> Severity:
    severity = BASE_SEVERITY[finding_class]
    if feature_kind is not None and finding_class in ESCALATED_CLASSES:
        severity = shifted(severity, KIND_ESCALATION[feature_kind])
    if standing is RoleStanding.highest and finding_class in RELIEVED_CLASSES:
        severity = shifted(severity, -ROLE_RELIEF_STEPS)
    return severity
