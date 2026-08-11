from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from tessa_api.schemas.enums import UserRole
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

ANY_ID = "0198f6f2-7b00-7a00-9d00-000000000001"
TARGET_ID = "0198f6f2-7b00-7a00-9d00-000000000006"
SELECTION: dict[str, Any] = {
    "feature_ids": ["smart_log.read.open_maintenance"],
    "area_ids": [],
    "roles": ["all"],
    "interface_mode": "both",
    "depth": "smoke",
    "k": 2,
}
PLAN_CREATE: dict[str, Any] = {"target_id": TARGET_ID, "saved": True, "selection": SELECTION}
IDEMPOTENCY: dict[str, str] = {"Idempotency-Key": "stage-two-stub-key-1"}
STREAMING = 0


@dataclass(frozen=True)
class Stub:
    method: str
    path: str
    minimum_role: UserRole | None
    empty_status: int
    body: dict[str, Any] | None = None
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return f"{self.method} {self.path}"


STUBS = [
    Stub("POST", "/api/v1/plans/preview", UserRole.viewer, 404, PLAN_CREATE),
    Stub("POST", "/api/v1/plans", UserRole.member, 404, PLAN_CREATE),
    Stub("GET", "/api/v1/plans", UserRole.viewer, 200),
    Stub("GET", f"/api/v1/plans/{ANY_ID}", UserRole.viewer, 404),
    Stub("PATCH", f"/api/v1/plans/{ANY_ID}", UserRole.member, 404, {"name": "Smoke"}),
    Stub("DELETE", f"/api/v1/plans/{ANY_ID}", UserRole.member, 404),
    Stub("GET", f"/api/v1/plans/{ANY_ID}/cells", UserRole.viewer, 404),
    Stub("GET", "/api/v1/scenarios", UserRole.viewer, 200),
    Stub("GET", f"/api/v1/scenarios/{ANY_ID}", UserRole.viewer, 404),
    Stub("POST", "/api/v1/runs", UserRole.member, 404, {"plan_id": ANY_ID}, IDEMPOTENCY),
    Stub("GET", "/api/v1/runs", UserRole.viewer, 200),
    Stub("GET", f"/api/v1/runs/{ANY_ID}", UserRole.viewer, 404),
    Stub("POST", f"/api/v1/runs/{ANY_ID}/cancel", UserRole.member, 404),
    Stub("GET", f"/api/v1/runs/{ANY_ID}/scenarios", UserRole.viewer, 404),
    Stub("GET", f"/api/v1/runs/{ANY_ID}/browser-sessions", UserRole.viewer, 404),
    Stub("GET", f"/api/v1/run-scenarios/{ANY_ID}", UserRole.viewer, 404),
    Stub("GET", f"/api/v1/steps/{ANY_ID}", UserRole.viewer, 404),
    Stub("GET", "/api/v1/artifacts/signed-token-value", None, 403),
    Stub("GET", "/api/v1/feeds/runs", UserRole.viewer, STREAMING),
]
AUTHENTICATED = [stub for stub in STUBS if stub.minimum_role is not None]
MEMBER_ONLY = [stub for stub in STUBS if stub.minimum_role is UserRole.member]
ANSWERING = [stub for stub in AUTHENTICATED if stub.empty_status != STREAMING]


def assert_empty_database_answer(stub: Stub, response: httpx.Response) -> None:
    assert response.status_code == stub.empty_status, (stub.label, response.text)
    if stub.empty_status == 404:
        assert response.json()["error"]["code"] == "not_found"
        assert response.json()["error"]["request_id"]


async def call(
    client: httpx.AsyncClient, stub: Stub, headers: dict[str, str] | None = None
) -> httpx.Response:
    return await client.request(
        stub.method,
        stub.path,
        json=stub.body,
        headers={**stub.headers, **(headers or {})},
    )


def ids(stub: Stub) -> str:
    return stub.label


@pytest.mark.parametrize("stub", AUTHENTICATED, ids=ids)
async def test_without_a_token_a_stub_answers_the_authentication_error(
    db_app: Any, client: httpx.AsyncClient, stub: Stub
) -> None:
    response = await call(client, stub)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize("stub", MEMBER_ONLY, ids=ids)
async def test_a_viewer_is_refused_on_member_endpoints(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, stub: Stub
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await call(client, stub, auth_headers(viewer))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "role_required"


@pytest.mark.parametrize("stub", ANSWERING, ids=ids)
async def test_a_permitted_caller_gets_the_answer_of_an_empty_database(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, stub: Stub
) -> None:
    assert stub.minimum_role is not None
    user = await make_user(stub.minimum_role)
    response = await call(client, stub, auth_headers(user))
    assert_empty_database_answer(stub, response)


async def test_an_admin_reaches_a_member_endpoint(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    stub = next(stub for stub in STUBS if stub.label == f"POST /api/v1/runs/{ANY_ID}/cancel")
    admin = await make_user(UserRole.admin)
    assert_empty_database_answer(stub, await call(client, stub, auth_headers(admin)))


async def test_the_signed_artifact_route_needs_no_bearer_token_but_a_valid_link(
    client: httpx.AsyncClient, db_app: Any
) -> None:
    response = await client.get("/api/v1/artifacts/anything")
    assert response.status_code == 403
    error = response.json()["error"]
    assert error["code"] == "forbidden"
    assert error["message"] == "The link is invalid or has expired"


async def test_posting_a_run_without_an_idempotency_key_is_refused(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    response = await client.post(
        "/api/v1/runs", json={"plan_id": ANY_ID}, headers=auth_headers(member)
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "idempotency_key_required"


async def test_a_run_request_naming_both_a_plan_id_and_a_plan_is_a_validation_error(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    headers = {**auth_headers(member), **IDEMPOTENCY}
    both = await client.post(
        "/api/v1/runs", json={"plan_id": ANY_ID, "plan": PLAN_CREATE}, headers=headers
    )
    assert both.status_code == 422
    assert both.json()["error"]["code"] == "validation_failed"


async def test_a_depth_that_is_not_an_enum_value_is_located_in_the_body(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    response = await client.post(
        "/api/v1/plans/preview",
        json={**PLAN_CREATE, "selection": {**SELECTION, "depth": "exhaustive"}},
        headers=auth_headers(member),
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == [
        "body",
        "selection",
        "depth",
    ]


@pytest.mark.parametrize(
    "path",
    ["/api/v1/plans", "/api/v1/scenarios", "/api/v1/runs", f"/api/v1/runs/{ANY_ID}/scenarios"],
)
async def test_list_stubs_reject_unknown_query_and_sort_keys(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, path: str
) -> None:
    viewer = await make_user(UserRole.viewer)
    unknown = await client.get(path, params={"bogus": "1"}, headers=auth_headers(viewer))
    assert unknown.status_code == 422
    assert unknown.json()["error"]["details"][0]["loc"] == ["query", "bogus"]
    sort = await client.get(path, params={"sort": "nope"}, headers=auth_headers(viewer))
    assert sort.status_code == 422
    assert sort.json()["error"]["details"][0]["loc"] == ["query", "sort"]


@pytest.mark.parametrize("path", [f"/api/v1/runs/{ANY_ID}/browser-sessions", "/api/v1/feeds/runs"])
async def test_unpaged_filter_stubs_reject_unknown_query_keys(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, path: str
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await client.get(path, params={"bogus": "1"}, headers=auth_headers(viewer))
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["query", "bogus"]


async def test_enum_and_uuid_filters_are_validated_by_the_stub_signature(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    headers = auth_headers(viewer)
    bad_status = await client.get("/api/v1/runs", params={"status": "sleeping"}, headers=headers)
    assert bad_status.status_code == 422
    bad_id = await client.get("/api/v1/runs/not-a-uuid", headers=headers)
    assert bad_id.status_code == 422
    several = await client.get(
        "/api/v1/runs", params=[("status", "queued"), ("status", "running")], headers=headers
    )
    assert several.status_code == 200, several.text
    assert several.json()["items"] == []


async def test_the_existing_event_log_route_still_works_beside_the_new_run_routes(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await client.get(f"/api/v1/runs/{ANY_ID}/events", headers=auth_headers(viewer))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
