from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from tessa_api.schemas.enums import UserRole
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

ANY_ID = "0198f6f2-7b00-7a00-9d00-000000000001"
TARGET_ID = "0198f6f2-7b00-7a00-9d00-000000000006"
IDEMPOTENCY: dict[str, str] = {"Idempotency-Key": "stage-three-four-stub-1"}


@dataclass(frozen=True)
class Stub:
    method: str
    path: str
    minimum_role: UserRole
    empty_status: int
    body: dict[str, Any] | None = None
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return f"{self.method} {self.path}"


STUBS = [
    Stub("GET", f"/api/v1/targets/{TARGET_ID}/seeds", UserRole.viewer, 404),
    Stub("GET", f"/api/v1/seeds/{ANY_ID}", UserRole.viewer, 404),
    Stub(
        "POST", f"/api/v1/targets/{TARGET_ID}/seeds/verify", UserRole.member, 404, {}, IDEMPOTENCY
    ),
    Stub(
        "POST",
        f"/api/v1/targets/{TARGET_ID}/seeds/reset",
        UserRole.member,
        404,
        {"confirm_target_name": "Gracie QA"},
        IDEMPOTENCY,
    ),
    Stub("GET", "/api/v1/oracle-templates", UserRole.viewer, 200),
    Stub("GET", f"/api/v1/oracle-templates/{ANY_ID}", UserRole.viewer, 404),
    Stub(
        "POST",
        f"/api/v1/oracle-templates/{ANY_ID}/runs",
        UserRole.member,
        404,
        {"params": {"tenant_id": "t"}},
        IDEMPOTENCY,
    ),
    Stub("GET", f"/api/v1/oracle-results/{ANY_ID}", UserRole.viewer, 404),
    Stub("GET", f"/api/v1/oracle-templates/{ANY_ID}/results", UserRole.viewer, 404),
    Stub(
        "PUT",
        f"/api/v1/oracle-templates/{ANY_ID}/approval",
        UserRole.member,
        404,
        {"approved": True, "oracle_result_id": ANY_ID},
    ),
    Stub("GET", "/api/v1/probes", UserRole.viewer, 200),
    Stub("GET", "/api/v1/settings", UserRole.viewer, 200),
    Stub(
        "PATCH",
        "/api/v1/settings",
        UserRole.admin,
        200,
        {"thresholds": {"probe_confidence": 0.8}},
    ),
    Stub(
        "PUT",
        "/api/v1/settings/secrets/openai_api_key",
        UserRole.admin,
        200,
        {"value": "sk-test"},
    ),
    Stub("DELETE", "/api/v1/settings/secrets/openai_api_key", UserRole.admin, 204),
    Stub("POST", "/api/v1/settings/test/laya", UserRole.admin, 200),
    Stub("GET", "/api/v1/labels/queue", UserRole.viewer, 200),
    Stub("GET", "/api/v1/labels", UserRole.viewer, 200),
    Stub("GET", "/api/v1/labels/stats", UserRole.viewer, 200),
    Stub(
        "POST",
        "/api/v1/labels",
        UserRole.member,
        404,
        {"subject_type": "step", "subject_id": ANY_ID, "value": "pass"},
    ),
    Stub("DELETE", f"/api/v1/labels/{ANY_ID}", UserRole.member, 404),
]
MEMBER_AND_UP = [stub for stub in STUBS if stub.minimum_role is not UserRole.viewer]
ADMIN_ONLY = [stub for stub in STUBS if stub.minimum_role is UserRole.admin]

PAGED_PATHS = [
    f"/api/v1/targets/{TARGET_ID}/seeds",
    "/api/v1/oracle-templates",
    f"/api/v1/oracle-templates/{ANY_ID}/results",
    "/api/v1/probes",
    "/api/v1/labels/queue",
    "/api/v1/labels",
]
UNPAGED_PATHS = ["/api/v1/settings", "/api/v1/labels/stats"]


def assert_empty_database_answer(stub: Stub, response: httpx.Response) -> None:
    assert response.status_code == stub.empty_status, (stub.label, response.text)
    if stub.empty_status == 404:
        assert response.json()["error"]["code"] == "not_found"
        assert response.json()["error"]["request_id"]


async def call(
    client: httpx.AsyncClient, stub: Stub, headers: dict[str, str] | None = None
) -> httpx.Response:
    return await client.request(
        stub.method, stub.path, json=stub.body, headers={**stub.headers, **(headers or {})}
    )


def ids(stub: Stub) -> str:
    return stub.label


def stub_by_label(label: str) -> Stub:
    return next(stub for stub in STUBS if stub.label == label)


def test_the_stub_table_covers_every_stage_three_and_four_operation() -> None:
    assert len(STUBS) == 21
    assert len({stub.label for stub in STUBS}) == 21


@pytest.mark.parametrize("stub", STUBS, ids=ids)
async def test_without_a_token_a_stub_answers_the_authentication_error(
    db_app: Any, client: httpx.AsyncClient, stub: Stub
) -> None:
    response = await call(client, stub)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize("stub", MEMBER_AND_UP, ids=ids)
async def test_a_viewer_is_refused_on_member_and_admin_endpoints(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, stub: Stub
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await call(client, stub, auth_headers(viewer))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "role_required"


@pytest.mark.parametrize("stub", ADMIN_ONLY, ids=ids)
async def test_a_member_is_refused_on_admin_endpoints(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, stub: Stub
) -> None:
    member = await make_user(UserRole.member)
    response = await call(client, stub, auth_headers(member))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "role_required"


@pytest.mark.parametrize("stub", STUBS, ids=ids)
async def test_a_permitted_caller_gets_the_answer_of_an_empty_database(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, stub: Stub
) -> None:
    user = await make_user(stub.minimum_role)
    response = await call(client, stub, auth_headers(user))
    assert_empty_database_answer(stub, response)


async def test_an_admin_reaches_viewer_member_and_admin_endpoints(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    admin = await make_user(UserRole.admin)
    for minimum_role in UserRole:
        stub = next(stub for stub in STUBS if stub.minimum_role is minimum_role)
        response = await call(client, stub, auth_headers(admin))
        assert_empty_database_answer(stub, response)


@pytest.mark.parametrize(
    "path",
    [
        f"/api/v1/targets/{TARGET_ID}/seeds/verify",
        f"/api/v1/targets/{TARGET_ID}/seeds/reset",
        f"/api/v1/oracle-templates/{ANY_ID}/runs",
    ],
)
async def test_workflow_starting_posts_without_an_idempotency_key_are_refused(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, path: str
) -> None:
    member = await make_user(UserRole.member)
    body: dict[str, Any] = (
        {"confirm_target_name": "Gracie QA"} if path.endswith("reset") else {"params": {}}
    )
    response = await client.post(path, json=body, headers=auth_headers(member))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "idempotency_key_required"


async def test_label_posts_need_no_idempotency_key(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    stub = stub_by_label("POST /api/v1/labels")
    assert not stub.headers
    assert_empty_database_answer(stub, await call(client, stub, auth_headers(member)))


async def test_a_reset_without_the_typed_target_name_is_a_validation_error(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    response = await client.post(
        f"/api/v1/targets/{TARGET_ID}/seeds/reset",
        json={},
        headers={**auth_headers(member), **IDEMPOTENCY},
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert error["details"][0]["loc"] == ["body", "confirm_target_name"]


async def test_a_seed_path_with_a_bad_target_id_is_a_validation_error(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await client.get("/api/v1/targets/not-a-uuid/seeds", headers=auth_headers(viewer))
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["path", "target_id"]


@pytest.mark.parametrize("path", PAGED_PATHS)
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


@pytest.mark.parametrize("path", UNPAGED_PATHS)
async def test_unpaged_reads_reject_unknown_query_keys(
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
    for path, params in (
        ("/api/v1/labels/queue", {"reason": "bored"}),
        ("/api/v1/labels/queue", {"subject_type": "run"}),
        ("/api/v1/labels", {"source": "robot"}),
        ("/api/v1/labels", {"subject_id": "nope"}),
        ("/api/v1/oracle-templates", {"approval": "maybe"}),
        ("/api/v1/oracle-templates", {"target_id": "nope"}),
        ("/api/v1/probes", {"pack": "custom"}),
    ):
        response = await client.get(path, params=params, headers=headers)
        assert response.status_code == 422, (path, params)
        assert response.json()["error"]["code"] == "validation_failed"


async def test_multi_value_filters_reach_the_handler(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await client.get(
        "/api/v1/labels/queue",
        params=[("reason", "uncertain"), ("reason", "audit"), ("subject_type", "step")],
        headers=auth_headers(viewer),
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


@pytest.mark.parametrize(
    ("method", "path", "body", "parameter"),
    [
        ("PUT", "/api/v1/settings/secrets/not_a_secret", {"value": "x"}, "name"),
        ("DELETE", "/api/v1/settings/secrets/not_a_secret", None, "name"),
        ("POST", "/api/v1/settings/test/not_a_service", None, "service"),
    ],
)
async def test_unknown_secret_and_service_names_are_validation_errors(
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    parameter: str,
) -> None:
    admin = await make_user(UserRole.admin)
    response = await client.request(method, path, json=body, headers=auth_headers(admin))
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["path", parameter]


@pytest.mark.parametrize(
    ("document", "location"),
    [
        ({"surprise": {}}, ["body", "surprise"]),
        ({"thresholds": {"probe_confidence": 1.5}}, ["body", "thresholds", "probe_confidence"]),
        ({"thresholds": {"nope": 1}}, ["body", "thresholds", "nope"]),
        ({"models": {"judge": {"effort": "extreme"}}}, ["body", "models", "judge", "effort"]),
    ],
)
async def test_a_settings_patch_is_validated_before_the_stub_runs(
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    document: dict[str, Any],
    location: list[str],
) -> None:
    admin = await make_user(UserRole.admin)
    response = await client.patch("/api/v1/settings", json=document, headers=auth_headers(admin))
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert error["details"][0]["loc"][: len(location)] == location


async def test_a_settings_patch_with_a_null_group_is_refused(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    admin = await make_user(UserRole.admin)
    response = await client.patch(
        "/api/v1/settings", json={"thresholds": None}, headers=auth_headers(admin)
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"


async def test_a_null_leaf_passes_validation_so_an_override_can_be_removed(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    admin = await make_user(UserRole.admin)
    headers = auth_headers(admin)
    overridden = await client.patch(
        "/api/v1/settings", json={"thresholds": {"probe_confidence": 0.8}}, headers=headers
    )
    assert overridden.json()["thresholds"]["probe_confidence"] == 0.8
    response = await client.patch(
        "/api/v1/settings",
        json={"thresholds": {"probe_confidence": None}},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["thresholds"]["probe_confidence"] == 0.75


async def test_an_empty_secret_value_is_a_validation_error(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    admin = await make_user(UserRole.admin)
    response = await client.put(
        "/api/v1/settings/secrets/openai_api_key", json={"value": ""}, headers=auth_headers(admin)
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["body", "value"]


async def test_a_label_with_an_unknown_subject_type_or_value_is_a_validation_error(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    base = {"subject_type": "step", "subject_id": ANY_ID, "value": "pass"}
    for broken in ({"subject_type": "run"}, {"value": "maybe"}, {"subject_id": "nope"}):
        response = await client.post(
            "/api/v1/labels", json={**base, **broken}, headers=auth_headers(member)
        )
        assert response.status_code == 422, broken
        assert response.json()["error"]["code"] == "validation_failed"


async def test_the_static_label_routes_are_not_captured_by_the_label_id_route(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    member = await make_user(UserRole.member)
    response = await client.delete("/api/v1/labels/queue", headers=auth_headers(member))
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["path", "label_id"]
    methods = await client.post("/api/v1/labels/stats", json={}, headers=auth_headers(member))
    assert methods.status_code == 405
    assert methods.json()["error"]["code"] == "method_not_allowed"
