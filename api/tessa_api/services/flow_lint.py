from collections.abc import Collection

from tessa_api.schemas.bundle_files import Flow
from tessa_api.schemas.bundle_references import (
    LOOSE_PLACEHOLDER_PATTERN,
    PLACEHOLDER_PATTERN,
    ManifestProblem,
    walk_strings,
)

ANONYMOUS_ROLE = "anonymous"


def lint_flow(
    flow: Flow,
    file_stem: str,
    feature_ids: Collection[str],
    role_ids: Collection[str],
    environment_names: Collection[str],
) -> list[ManifestProblem]:
    problems: list[ManifestProblem] = []
    if flow.id != file_stem:
        problems.append(
            ManifestProblem(
                code="flow_id_mismatch",
                message=f"The flow id {flow.id!r} must equal the file name {file_stem!r}",
                loc=("id",),
                value=flow.id,
            )
        )
    problems.extend(
        ManifestProblem(
            code="unknown_feature",
            message=f"The flow cites feature {feature_id!r}, which the manifest does not declare",
            loc=("feature_ids", position),
            value=feature_id,
        )
        for position, feature_id in enumerate(flow.feature_ids)
        if feature_id not in feature_ids
    )
    if flow.role != ANONYMOUS_ROLE and flow.role not in role_ids:
        problems.append(
            ManifestProblem(
                code="unknown_role",
                message=f"The flow runs as role {flow.role!r}, which the manifest does not "
                f"declare (use {ANONYMOUS_ROLE!r} before any login)",
                loc=("role",),
                value=flow.role,
            )
        )
    document = flow.model_dump(mode="json", by_alias=True)
    for loc, text in walk_strings(document, ()):
        for match in LOOSE_PLACEHOLDER_PATTERN.finditer(text):
            name = match.group(1)
            if PLACEHOLDER_PATTERN.fullmatch(match.group(0)) is None:
                problems.append(
                    ManifestProblem(
                        code="invalid_placeholder",
                        message=f"Placeholder ${{{name}}} must use upper case letters, digits and "
                        "underscores and start with a letter",
                        loc=loc,
                        value=match.group(0),
                    )
                )
            elif name not in environment_names:
                problems.append(
                    ManifestProblem(
                        code="undeclared_placeholder",
                        message=f"Placeholder ${{{name}}} is not declared in the manifest "
                        "environment",
                        loc=loc,
                        value=match.group(0),
                    )
                )
    return problems
