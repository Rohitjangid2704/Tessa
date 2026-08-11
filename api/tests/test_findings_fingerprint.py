import uuid

import pytest

from tessa_api.schemas.enums import FindingClass
from tessa_api.services.findings.fingerprint import (
    SIGNAL_LIMIT,
    compute_fingerprint,
    normalize_signal,
    path_template,
    request_target,
    server_error_signal,
)

TARGET = uuid.UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11")


def fingerprint(
    target_id: uuid.UUID = TARGET,
    finding_class: FindingClass = FindingClass.wrong_result,
    check: str = "oracle_count",
    feature_id: str | None = "smart_log.read.open_maintenance",
    interface_id: str | None = "chat_sse",
    role: str | None = "staff",
    signal: str = "expected <n> open issues",
) -> str:
    return compute_fingerprint(
        target_id, finding_class, check, feature_id, interface_id, role, signal
    )


def test_volatile_parts_of_a_signal_are_replaced_by_tokens() -> None:
    first = normalize_signal(
        "Order 12345 failed at 2026-10-14T10:20:30Z for user "
        "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11, trace deadbeef1234abcd"
    )
    second = normalize_signal(
        "order 98 failed at 2025-01-02T03:04:05+01:00 for user "
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,   trace 0123456789abcdef"
    )
    assert first == "order <n> failed at <ts> for user <uuid>, trace <hex>"
    assert second == first


def test_a_time_of_day_and_whitespace_are_normalized_too() -> None:
    assert normalize_signal("Slot  at 9:30\n\tbooked") == "slot at <time> booked"


def test_a_long_signal_is_clipped_to_the_limit() -> None:
    clipped = normalize_signal("word " * 200)
    assert len(clipped) == SIGNAL_LIMIT


@pytest.mark.parametrize(
    ("address", "template"),
    [
        ("https://app.test/api/orders/12345/items", "/api/orders/{id}/items"),
        ("https://app.test/api/users/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11", "/api/users/{id}"),
        ("https://app.test/api/files/abc12345", "/api/files/{id}"),
        ("https://app.test/api/v1/orders?page=2", "/api/v1/orders"),
        ("https://app.test", "/"),
    ],
)
def test_identifiers_in_a_path_become_one_placeholder(address: str, template: str) -> None:
    assert path_template(address) == template


def test_the_request_target_names_the_method_and_the_templated_path() -> None:
    assert request_target("get", "https://app.test/api/orders/42") == "GET /api/orders/{id}"
    assert request_target(None, None) == "- -"
    assert server_error_signal(503, "GET /health") == "503 GET /health"


def test_the_fingerprint_is_stable_and_changes_with_every_field() -> None:
    base = fingerprint()
    assert base == fingerprint()
    assert len(base) == 64
    variants = [
        fingerprint(target_id=uuid.uuid4()),
        fingerprint(finding_class=FindingClass.server_error),
        fingerprint(check="oracle_rows"),
        fingerprint(feature_id="admin.users.list"),
        fingerprint(interface_id="browser"),
        fingerprint(role="manager"),
        fingerprint(signal="expected <n> closed issues"),
    ]
    assert base not in variants
    assert len(set(variants)) == len(variants)


def test_absent_cell_fields_still_give_a_fingerprint() -> None:
    absent = fingerprint(feature_id=None, interface_id=None, role=None)
    assert absent != fingerprint()
    assert absent == fingerprint(feature_id=None, interface_id=None, role=None)
