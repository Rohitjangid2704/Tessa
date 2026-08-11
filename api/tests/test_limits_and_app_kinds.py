import httpx
import pytest
from fastapi import FastAPI

from tessa_api.main import create_app
from tessa_api.schemas.enums import AppKind, UserRole
from tessa_api.services.app_kinds import (
    APP_KIND_REGISTRY,
    default_hint_ids,
    hint_instructions,
    known_hint_ids,
)
from tests.support import AuthHeaders, MakeUser, settings_with

LIMITS_PATH = "/api/v1/limits"
APP_KINDS_PATH = "/api/v1/app-kinds"


@pytest.mark.integration
async def test_limits_come_from_the_settings(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await client.get(LIMITS_PATH, headers=auth_headers(viewer))
    assert response.status_code == 200
    assert response.json() == {
        "bundle_max_zip_bytes": 26214400,
        "bundle_max_manifest_bytes": 1048576,
        "explanation_max_chars": 20000,
    }


@pytest.mark.integration
async def test_limits_follow_a_changed_environment(
    db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    configured = settings_with(bundle_max_zip_bytes=1000, bundle_max_manifest_bytes=50)
    app = create_app(configured)
    viewer = await make_user(UserRole.viewer)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            response = await http.get(LIMITS_PATH, headers=auth_headers(viewer))
    assert response.json()["bundle_max_zip_bytes"] == 1000
    assert response.json()["bundle_max_manifest_bytes"] == 50


async def test_limits_and_app_kinds_need_authentication(client: httpx.AsyncClient) -> None:
    assert (await client.get(LIMITS_PATH)).status_code == 401
    assert (await client.get(APP_KINDS_PATH)).status_code == 401


@pytest.mark.integration
async def test_app_kinds_list_every_kind_with_hints(
    client: httpx.AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    viewer = await make_user(UserRole.viewer)
    response = await client.get(APP_KINDS_PATH, headers=auth_headers(viewer))
    assert response.status_code == 200
    items = response.json()["items"]
    assert [item["kind"] for item in items] == [kind.value for kind in AppKind]
    for item in items:
        assert item["label"]
        assert item["hints"]
        for hint in item["hints"]:
            assert set(hint) == {"id", "label", "default_on"}
    assistant = next(item for item in items if item["kind"] == "llm_assistant")
    assert [hint["id"] for hint in assistant["hints"]] == [
        "list_tools",
        "confirmation_gate",
        "transcript_trace_endpoints",
    ]
    assert all(hint["default_on"] for hint in assistant["hints"])


def test_registry_covers_each_kind_once_and_hint_ids_are_unique() -> None:
    assert [definition.kind for definition in APP_KIND_REGISTRY] == list(AppKind)
    for definition in APP_KIND_REGISTRY:
        ids = [hint.id for hint in definition.hints]
        assert len(ids) == len(set(ids))
        assert all(hint.instruction.strip() for hint in definition.hints)


def test_hint_instructions_follow_registry_order_and_ignore_unknown_ids() -> None:
    instructions = hint_instructions(
        AppKind.llm_assistant, ["transcript_trace_endpoints", "list_tools", "no_such_hint"]
    )
    assert len(instructions) == 2
    assert "tool" in instructions[0].lower()
    assert "transcript" in instructions[1].lower()


def test_default_and_known_hint_ids() -> None:
    assert known_hint_ids(AppKind.api) == ["openapi_schema", "rate_limits_and_idempotency"]
    assert default_hint_ids(AppKind.api) == ["openapi_schema"]
