import base64
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import UserRole
from tessa_api.services.pagination import (
    SortTerm,
    decode_cursor,
    encode_cursor,
    parse_sort,
)
from tests.stage_one import TARGETS_PATH, create_target
from tests.support import AuthHeaders, MakeUser

ALLOWED = ("name", "created_at")


def unwrap(error: ApiError) -> ErrorDetail:
    assert error.status_code == 422
    assert error.code == "validation_failed"
    return error.details[0]


def test_sort_grammar_reads_leading_minus_as_descending() -> None:
    assert parse_sort("-created_at,name", ALLOWED) == (
        SortTerm("created_at", True),
        SortTerm("name", False),
    )


def test_unknown_sort_key_points_at_the_sort_parameter() -> None:
    with pytest.raises(ApiError) as caught:
        parse_sort("owner", ALLOWED)
    detail = unwrap(caught.value)
    assert detail.loc == ["query", "sort"]
    assert detail.code == "unknown_sort_key"


@pytest.mark.parametrize("raw", ["name,", ",name", "-", "name,-name"])
def test_malformed_sort_is_rejected(raw: str) -> None:
    with pytest.raises(ApiError) as caught:
        parse_sort(raw, ALLOWED)
    assert unwrap(caught.value).loc == ["query", "sort"]


def test_cursor_round_trips_typed_values() -> None:
    moment = datetime(2026, 10, 1, 12, 30, 45, 123456, tzinfo=UTC)
    identifier = uuid.uuid4()
    cursor = encode_cursor("-created_at", [moment, identifier])
    assert decode_cursor(cursor, "-created_at", [datetime, uuid.UUID]) == [moment, identifier]


def test_cursor_is_urlsafe_base64_of_json_without_padding() -> None:
    cursor = encode_cursor("name", ["Gracie", uuid.UUID(int=1)])
    assert "=" not in cursor
    assert "+" not in cursor
    assert "/" not in cursor
    padded = cursor + "=" * (-len(cursor) % 4)
    assert json.loads(base64.urlsafe_b64decode(padded)) == {
        "sort": "name",
        "values": ["Gracie", str(uuid.UUID(int=1))],
    }


@pytest.mark.parametrize(
    "cursor",
    ["not base64 !!", "e30", "bm90LWpzb24", encode_cursor("name", ["only-one-value"])],
)
def test_garbled_cursors_are_rejected(cursor: str) -> None:
    with pytest.raises(ApiError) as caught:
        decode_cursor(cursor, "name", [str, uuid.UUID])
    detail = unwrap(caught.value)
    assert detail.loc == ["query", "cursor"]
    assert detail.code == "invalid_cursor"


def test_cursor_of_another_sort_is_rejected() -> None:
    cursor = encode_cursor("name", ["a", uuid.uuid4()])
    with pytest.raises(ApiError) as caught:
        decode_cursor(cursor, "-created_at", [datetime, uuid.UUID])
    assert unwrap(caught.value).code == "invalid_cursor"


def test_cursor_with_a_value_of_the_wrong_type_is_rejected() -> None:
    cursor = encode_cursor("name", [5, str(uuid.uuid4())])
    with pytest.raises(ApiError) as caught:
        decode_cursor(cursor, "name", [str, uuid.UUID])
    assert unwrap(caught.value).code == "invalid_cursor"


@pytest.fixture
async def member_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.member))


async def collect_pages(
    client: httpx.AsyncClient, headers: dict[str, str], params: dict[str, Any]
) -> tuple[list[dict[str, Any]], int]:
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    pages = 0
    while True:
        query = {**params, **({"cursor": cursor} if cursor else {})}
        response = await client.get(TARGETS_PATH, params=query, headers=headers)
        assert response.status_code == 200, response.text
        body = response.json()
        items.extend(body["items"])
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            return items, pages
        assert pages < 20


@pytest.mark.integration
async def test_ties_on_the_sort_key_page_without_gaps_or_duplicates(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    for name in ("Beta", "Alpha", "Beta", "Beta", "Alpha", "Gamma", "Beta"):
        await create_target(client, member_headers, name=name)
    items, pages = await collect_pages(client, member_headers, {"limit": 2, "sort": "name"})
    assert pages == 4
    assert len(items) == 7
    assert len({item["id"] for item in items}) == 7
    assert [item["name"] for item in items] == [
        "Alpha",
        "Alpha",
        "Beta",
        "Beta",
        "Beta",
        "Beta",
        "Gamma",
    ]
    tied = [item["id"] for item in items if item["name"] == "Beta"]
    assert tied == sorted(tied)


@pytest.mark.integration
async def test_descending_default_sort_pages_newest_first(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    for index in range(5):
        await create_target(client, member_headers, name=f"Target {index}")
    items, pages = await collect_pages(client, member_headers, {"limit": 2})
    assert pages == 3
    assert [item["name"] for item in items] == [f"Target {index}" for index in (4, 3, 2, 1, 0)]


@pytest.mark.integration
async def test_mixed_direction_sort_is_stable_across_pages(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    for name in ("B", "A", "B", "A", "C"):
        await create_target(client, member_headers, name=name)
    items, _ = await collect_pages(client, member_headers, {"limit": 2, "sort": "-name,created_at"})
    assert [item["name"] for item in items] == ["C", "B", "B", "A", "A"]
    created = [item["created_at"] for item in items if item["name"] == "B"]
    assert created == sorted(created)


@pytest.mark.integration
async def test_total_is_null_unless_requested(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    for index in range(3):
        await create_target(client, member_headers, name=f"T{index}")
    plain = await client.get(TARGETS_PATH, params={"limit": 2}, headers=member_headers)
    counted = await client.get(
        TARGETS_PATH, params={"limit": 2, "include_total": "true"}, headers=member_headers
    )
    assert plain.json()["total"] is None
    assert counted.json()["total"] == 3
    assert len(counted.json()["items"]) == 2
    assert counted.json()["next_cursor"] is not None


@pytest.mark.integration
async def test_last_page_has_no_cursor(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    await create_target(client, member_headers, name="Only")
    response = await client.get(TARGETS_PATH, params={"limit": 1}, headers=member_headers)
    assert response.json()["next_cursor"] is None


@pytest.mark.integration
async def test_unknown_filter_key_is_422_with_the_key_as_location(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.get(
        TARGETS_PATH, params={"colour": "red", "shape": "round"}, headers=member_headers
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert sorted(detail["loc"][1] for detail in error["details"]) == ["colour", "shape"]
    assert all(detail["loc"][0] == "query" for detail in error["details"])


@pytest.mark.integration
async def test_unknown_sort_key_is_422_on_the_sort_parameter(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.get(TARGETS_PATH, params={"sort": "owner"}, headers=member_headers)
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["query", "sort"]


@pytest.mark.integration
async def test_tampered_cursor_is_422_on_the_cursor_parameter(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.get(TARGETS_PATH, params={"cursor": "tampered"}, headers=member_headers)
    assert response.status_code == 422
    detail = response.json()["error"]["details"][0]
    assert detail["loc"] == ["query", "cursor"]
    assert detail["code"] == "invalid_cursor"


@pytest.mark.integration
async def test_cursor_from_another_sort_is_rejected_by_the_endpoint(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    for name in ("A", "B", "C"):
        await create_target(client, member_headers, name=name)
    first = await client.get(TARGETS_PATH, params={"limit": 1}, headers=member_headers)
    response = await client.get(
        TARGETS_PATH,
        params={"limit": 1, "sort": "name", "cursor": first.json()["next_cursor"]},
        headers=member_headers,
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["code"] == "invalid_cursor"


@pytest.mark.integration
@pytest.mark.parametrize("limit", ["0", "201", "abc"])
async def test_limit_outside_the_range_is_422(
    client: httpx.AsyncClient, member_headers: dict[str, str], limit: str
) -> None:
    response = await client.get(TARGETS_PATH, params={"limit": limit}, headers=member_headers)
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["query", "limit"]


@pytest.mark.integration
async def test_limit_of_200_is_accepted(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.get(TARGETS_PATH, params={"limit": 200}, headers=member_headers)
    assert response.status_code == 200
