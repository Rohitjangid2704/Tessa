from datetime import UTC, datetime, timedelta

import pytest

from tessa_api.db.models import FindingRow
from tessa_api.errors import ApiError
from tessa_api.schemas.enums import FindingStatus, Severity
from tessa_api.schemas.findings import FindingUpdate
from tessa_api.services.findings.lifecycle import (
    OPEN_STATUSES,
    SETTLED_STATUSES,
    USER_TRANSITIONS,
    apply_user_update,
    ensure_user_transition,
    status_after_occurrence,
)

LONG_AGO = datetime(2026, 1, 1, tzinfo=UTC)
ALLOWED_MOVES = [
    (current, requested)
    for current, allowed in USER_TRANSITIONS.items()
    for requested in sorted(allowed, key=lambda status: status.value)
]
REFUSED_MOVES = [
    (current, requested)
    for current in FindingStatus
    for requested in FindingStatus
    if requested is not current and requested not in USER_TRANSITIONS[current]
]


def finding(
    status: FindingStatus = FindingStatus.new,
    severity: Severity = Severity.medium,
    known_gap_reason: str | None = None,
    ticket_url: str | None = None,
) -> FindingRow:
    return FindingRow(
        status=status,
        severity=severity,
        known_gap_reason=known_gap_reason,
        ticket_url=ticket_url,
        status_changed_at=LONG_AGO,
    )


def test_every_status_has_a_row_in_the_transition_table() -> None:
    assert set(USER_TRANSITIONS) == set(FindingStatus)
    open_statuses = set(OPEN_STATUSES)
    assert open_statuses == {
        FindingStatus.new,
        FindingStatus.triaged,
        FindingStatus.in_fix,
        FindingStatus.verifying,
    }
    assert open_statuses.isdisjoint(SETTLED_STATUSES)


@pytest.mark.parametrize(("current", "requested"), ALLOWED_MOVES)
def test_a_user_may_make_every_move_of_the_table(
    current: FindingStatus, requested: FindingStatus
) -> None:
    ensure_user_transition(current, requested)


@pytest.mark.parametrize(("current", "requested"), REFUSED_MOVES)
def test_a_user_move_outside_the_table_is_a_conflict(
    current: FindingStatus, requested: FindingStatus
) -> None:
    with pytest.raises(ApiError) as caught:
        ensure_user_transition(current, requested)
    assert caught.value.status_code == 409
    assert caught.value.details[0].code == "transition_not_allowed"


def test_no_one_resolves_a_finding_by_hand() -> None:
    assert all(FindingStatus.resolved not in allowed for allowed in USER_TRANSITIONS.values())
    with pytest.raises(ApiError) as caught:
        ensure_user_transition(FindingStatus.verifying, FindingStatus.resolved)
    assert "passing re-run" in caught.value.message


def test_staying_in_the_same_status_is_always_allowed() -> None:
    for status in FindingStatus:
        ensure_user_transition(status, status)


def test_a_new_occurrence_reopens_a_resolved_finding_and_sends_verifying_back_to_in_fix() -> None:
    assert status_after_occurrence(FindingStatus.resolved) is FindingStatus.new
    assert status_after_occurrence(FindingStatus.verifying) is FindingStatus.in_fix
    for status in set(FindingStatus) - {FindingStatus.resolved, FindingStatus.verifying}:
        assert status_after_occurrence(status) is status


def test_a_move_records_the_change_and_the_time_of_the_move() -> None:
    row = finding(FindingStatus.new)
    changes = apply_user_update(row, FindingUpdate(status=FindingStatus.triaged))
    assert changes == {"status": ("new", "triaged")}
    assert row.status is FindingStatus.triaged
    assert row.status_changed_at > LONG_AGO + timedelta(days=1)


def test_known_gap_needs_a_reason_that_is_not_blank() -> None:
    for reason in (None, "   "):
        row = finding(FindingStatus.triaged)
        with pytest.raises(ApiError) as caught:
            apply_user_update(
                row, FindingUpdate(status=FindingStatus.known_gap, known_gap_reason=reason)
            )
        assert caught.value.status_code == 422
        assert caught.value.details[0].loc == ["body", "known_gap_reason"]
        assert row.status is FindingStatus.triaged


def test_known_gap_with_a_reason_stores_the_trimmed_reason() -> None:
    row = finding(FindingStatus.triaged)
    changes = apply_user_update(
        row,
        FindingUpdate(status=FindingStatus.known_gap, known_gap_reason="  vendor bug VB-12  "),
    )
    assert row.status is FindingStatus.known_gap
    assert row.known_gap_reason == "vendor bug VB-12"
    assert changes["known_gap_reason"] == (None, "vendor bug VB-12")


def test_a_stored_reason_carries_a_later_known_gap_move() -> None:
    row = finding(FindingStatus.triaged, known_gap_reason="accepted risk")
    apply_user_update(row, FindingUpdate(status=FindingStatus.known_gap))
    assert row.status is FindingStatus.known_gap
    assert row.known_gap_reason == "accepted risk"


def test_severity_and_ticket_changes_are_recorded_and_a_null_ticket_clears_it() -> None:
    row = finding(severity=Severity.low, ticket_url="https://tickets.test/T-1")
    changes = apply_user_update(row, FindingUpdate(severity=Severity.high, ticket_url=None))
    assert row.severity is Severity.high
    assert row.ticket_url is None
    assert changes == {
        "severity": ("low", "high"),
        "ticket_url": ("https://tickets.test/T-1", None),
    }


def test_an_update_that_changes_nothing_records_nothing() -> None:
    row = finding(FindingStatus.in_fix, severity=Severity.high)
    changes = apply_user_update(
        row, FindingUpdate(status=FindingStatus.in_fix, severity=Severity.high)
    )
    assert changes == {}
    assert row.status_changed_at == LONG_AGO


def test_a_refused_move_changes_nothing_on_the_row() -> None:
    row = finding(FindingStatus.dismissed, severity=Severity.low)
    with pytest.raises(ApiError):
        apply_user_update(row, FindingUpdate(status=FindingStatus.in_fix, severity=Severity.high))
    assert row.status is FindingStatus.dismissed
    assert row.severity is Severity.low
