import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime

from pydantic import JsonValue
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import FindingRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import FindingStatus
from tessa_api.schemas.findings import FindingUpdate

USER_TRANSITIONS: Mapping[FindingStatus, frozenset[FindingStatus]] = {
    FindingStatus.new: frozenset(
        {
            FindingStatus.triaged,
            FindingStatus.in_fix,
            FindingStatus.known_gap,
            FindingStatus.dismissed,
        }
    ),
    FindingStatus.triaged: frozenset(
        {
            FindingStatus.new,
            FindingStatus.in_fix,
            FindingStatus.known_gap,
            FindingStatus.dismissed,
        }
    ),
    FindingStatus.in_fix: frozenset(
        {
            FindingStatus.triaged,
            FindingStatus.verifying,
            FindingStatus.known_gap,
            FindingStatus.dismissed,
        }
    ),
    FindingStatus.verifying: frozenset({FindingStatus.in_fix, FindingStatus.triaged}),
    FindingStatus.resolved: frozenset({FindingStatus.triaged}),
    FindingStatus.known_gap: frozenset({FindingStatus.triaged, FindingStatus.dismissed}),
    FindingStatus.dismissed: frozenset({FindingStatus.triaged}),
}
OCCURRENCE_MOVES: Mapping[FindingStatus, FindingStatus] = {
    FindingStatus.resolved: FindingStatus.new,
    FindingStatus.verifying: FindingStatus.in_fix,
}
SETTLED_STATUSES = frozenset(
    {FindingStatus.resolved, FindingStatus.known_gap, FindingStatus.dismissed}
)
OPEN_STATUSES = frozenset(set(FindingStatus) - SETTLED_STATUSES)

Changes = dict[str, tuple[JsonValue, JsonValue]]


@dataclass(frozen=True, slots=True)
class UpdatedFinding:
    row: FindingRow
    changes: Changes = field(default_factory=dict)


def transition_not_allowed(current: FindingStatus, requested: FindingStatus) -> ApiError:
    allowed = sorted(status.value for status in USER_TRANSITIONS[current])
    if requested is FindingStatus.resolved:
        message = "A finding is resolved by a passing re-run, never by hand"
    else:
        message = (
            f"A {current.value} finding cannot move to {requested.value}; "
            f"allowed: {', '.join(allowed)}"
        )
    detail = ErrorDetail(loc=["body", "status"], code="transition_not_allowed", message=message)
    return ApiError(409, "conflict", message, [detail])


def known_gap_reason_required() -> ApiError:
    detail = ErrorDetail(
        loc=["body", "known_gap_reason"],
        code="value_error",
        message="Value error, known_gap_reason is required when status is known_gap",
    )
    return ApiError(422, "validation_failed", "Request validation failed", [detail])


def ensure_user_transition(current: FindingStatus, requested: FindingStatus) -> None:
    if requested is current:
        return
    if requested not in USER_TRANSITIONS[current]:
        raise transition_not_allowed(current, requested)


def status_after_occurrence(current: FindingStatus) -> FindingStatus:
    return OCCURRENCE_MOVES.get(current, current)


def move_to(row: FindingRow, status: FindingStatus, now: datetime | None = None) -> None:
    row.status = status
    row.status_changed_at = now or datetime.now(UTC)


def requested_reason(body: FindingUpdate, stored: str | None) -> str | None:
    if "known_gap_reason" not in body.model_fields_set:
        return stored
    return (body.known_gap_reason or "").strip() or None


def apply_user_update(row: FindingRow, body: FindingUpdate) -> Changes:
    changes: Changes = {}
    moves = body.status is not None and body.status is not row.status
    if body.status is not None and moves:
        ensure_user_transition(row.status, body.status)
    target_status = body.status if body.status is not None else row.status
    reason = requested_reason(body, row.known_gap_reason)
    if target_status is FindingStatus.known_gap and reason is None:
        raise known_gap_reason_required()
    if body.status is not None and moves:
        changes["status"] = (row.status.value, body.status.value)
        move_to(row, body.status)
    if body.severity is not None and body.severity is not row.severity:
        changes["severity"] = (row.severity.value, body.severity.value)
        row.severity = body.severity
    if "ticket_url" in body.model_fields_set and body.ticket_url != row.ticket_url:
        changes["ticket_url"] = (row.ticket_url, body.ticket_url)
        row.ticket_url = body.ticket_url
    if reason != row.known_gap_reason:
        changes["known_gap_reason"] = (row.known_gap_reason, reason)
        row.known_gap_reason = reason
    return changes


async def update_finding(
    session: AsyncSession, finding_id: uuid.UUID, body: FindingUpdate
) -> UpdatedFinding:
    row = await session.get(FindingRow, finding_id, with_for_update=True)
    if row is None:
        raise not_found("Finding not found")
    changes = apply_user_update(row, body)
    await session.commit()
    return UpdatedFinding(row=row, changes=changes)
