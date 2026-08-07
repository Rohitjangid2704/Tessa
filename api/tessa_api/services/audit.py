import math
import re
import uuid
from collections.abc import Mapping
from enum import Enum
from typing import Any, Final

from pydantic import JsonValue
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import AuditEventRow
from tessa_api.schemas.audit import AuditDetail
from tessa_api.schemas.enums import AuditAction, AuditSubjectType, AuditVia
from tessa_api.services.audit_context import current_audit_context
from tessa_api.services.secret_scan import find_matches, redact_line

SECRET_KEY_PATTERN: Final = re.compile(
    r"password|passwd|secret|token|key|credential|dsn|value", re.IGNORECASE
)
AUDIT_STRING_MAX_LENGTH: Final = 500
AUDIT_LIST_MAX_ITEMS: Final = 100
AUDIT_MAX_DEPTH: Final = 5
TRUNCATION_MARK: Final = "..."

AUDIT_ACTION_SUBJECTS: Final[Mapping[AuditAction, AuditSubjectType]] = {
    AuditAction.user_created: AuditSubjectType.user,
    AuditAction.user_role_changed: AuditSubjectType.user,
    AuditAction.user_active_changed: AuditSubjectType.user,
    AuditAction.sso_user_provisioned: AuditSubjectType.user,
    AuditAction.team_created: AuditSubjectType.team,
    AuditAction.team_renamed: AuditSubjectType.team,
    AuditAction.team_members_changed: AuditSubjectType.team,
    AuditAction.team_budget_set: AuditSubjectType.team,
    AuditAction.target_team_changed: AuditSubjectType.target,
    AuditAction.retention_policy_changed: AuditSubjectType.retention,
    AuditAction.secret_set: AuditSubjectType.secret,
    AuditAction.secret_deleted: AuditSubjectType.secret,
    AuditAction.allow_production_changed: AuditSubjectType.target,
    AuditAction.token_created: AuditSubjectType.personal_token,
    AuditAction.token_revoked: AuditSubjectType.personal_token,
    AuditAction.personal_token_write: AuditSubjectType.route,
    AuditAction.proposal_put: AuditSubjectType.proposal,
    AuditAction.proposal_item_changed: AuditSubjectType.proposal,
}


def audited_actions() -> tuple[AuditAction, ...]:
    return tuple(AUDIT_ACTION_SUBJECTS)


def audit_subject_type_of(action: AuditAction) -> AuditSubjectType:
    return AUDIT_ACTION_SUBJECTS[action]


def is_secret_key(name: str) -> bool:
    return SECRET_KEY_PATTERN.search(name) is not None


def truncate_text(text: str) -> str:
    if len(text) <= AUDIT_STRING_MAX_LENGTH:
        return text
    return text[: AUDIT_STRING_MAX_LENGTH - len(TRUNCATION_MARK)] + TRUNCATION_MARK


def mask_line(line: str) -> str:
    found = find_matches(line)
    return redact_line(line, found) if found else line


def clean_text(text: str) -> str:
    return "\n".join(mask_line(line) for line in truncate_text(text).split("\n"))


def clean_mapping(value: Mapping[Any, Any], depth: int) -> dict[str, JsonValue]:
    if depth >= AUDIT_MAX_DEPTH:
        return {}
    cleaned: dict[str, JsonValue] = {}
    for raw_name, item in value.items():
        name = str(raw_name)
        if is_secret_key(name):
            continue
        cleaned[clean_text(name)] = clean_value(item, depth + 1)
    return cleaned


def clean_sequence(items: list[object], depth: int) -> list[JsonValue]:
    if depth >= AUDIT_MAX_DEPTH:
        return []
    return [clean_value(item, depth + 1) for item in items[:AUDIT_LIST_MAX_ITEMS]]


def clean_number(value: float) -> JsonValue:
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


def clean_value(value: object, depth: int) -> JsonValue:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return clean_number(value)
    if isinstance(value, Enum):
        return clean_value(value.value, depth)
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, Mapping):
        return clean_mapping(value, depth)
    if isinstance(value, list | tuple | set | frozenset):
        return clean_sequence(list(value), depth)
    return clean_text(str(value))


def redact_audit_detail(detail: AuditDetail) -> AuditDetail:
    return clean_mapping(detail, 0)


async def record_audit(
    session: AsyncSession,
    actor_user_id: uuid.UUID | None,
    action: AuditAction,
    subject_type: AuditSubjectType,
    subject_id: uuid.UUID | None,
    detail: AuditDetail,
    *,
    via: AuditVia | None = None,
    agent_session_id: uuid.UUID | None = None,
) -> None:
    context = current_audit_context()
    session.add(
        AuditEventRow(
            actor_user_id=actor_user_id,
            action=action,
            subject_type=subject_type,
            subject_id=subject_id,
            detail=redact_audit_detail(detail),
            via=via if via is not None else context.via,
            agent_session_id=(
                agent_session_id if agent_session_id is not None else context.agent_session_id
            ),
        )
    )
