import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update

from tessa_api.db.models import BundleRow, PromptIssueRow, PromptTemplateRow
from tessa_api.schemas.enums import (
    AppKind,
    BundleSourceKind,
    BundleValidationStatus,
    PromptTemplateName,
    UserRole,
)
from tessa_api.services.app_kinds import default_hint_ids, hint_instructions, known_hint_ids
from tests.stage_one import TARGETS_PATH, create_target
from tests.support import AuthHeaders, MakeUser
from tests.test_prompt_templates import (
    CURRENT_VERSIONS,
    SHIPPED_VERSIONS,
    UNSHIPPED_DISCOVERY_VERSION,
    restore_template_rows,
    shipped_text,
    shipped_version_text,
    template_rows,
)

pytestmark = pytest.mark.integration

TEMPLATES_PATH = "/api/v1/prompt-templates"
ISSUES_PATH = "/api/v1/prompt-issues"
SCHEMA_URL = "http://localhost:8000/schemas/bundle.v1.json"
IDEMPOTENCY_HEADER = "Idempotency-Key"
LISTED_ORDER = sorted(SHIPPED_VERSIONS, key=lambda item: (item[0], -item[1]))


def issues_path(target_id: str) -> str:
    return f"{TARGETS_PATH}/{target_id}/prompt-issues"


@pytest.fixture
async def member_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.member))


@pytest.fixture
async def viewer_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.viewer))


@pytest.fixture
async def admin_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.admin))


@pytest.fixture
async def target(client: httpx.AsyncClient, member_headers: dict[str, str]) -> dict[str, Any]:
    return await create_target(client, member_headers)


@pytest.fixture
async def restore_templates(db_app: FastAPI) -> AsyncIterator[None]:
    rows = await template_rows(db_app)
    yield
    await restore_template_rows(db_app, rows)


async def issue_discovery(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    target_id: str,
    hint_ids: list[str] | None = None,
    **extra_headers: str,
) -> httpx.Response:
    body: dict[str, Any] = {"template_name": "discovery"}
    if hint_ids is not None:
        body["hint_ids"] = hint_ids
    return await client.post(
        issues_path(target_id), json=body, headers={**headers, **extra_headers}
    )


async def insert_bundle_row(
    app: FastAPI,
    target_id: str,
    uploaded_by: uuid.UUID,
    version: int = 1,
    score: int = 62,
    errors: list[dict[str, Any]] | None = None,
    warnings: list[dict[str, Any]] | None = None,
    checks: list[dict[str, Any]] | None = None,
) -> BundleRow:
    row = BundleRow(
        target_id=uuid.UUID(target_id),
        version=version,
        hash=f"hash-{target_id}-{version}",
        source=BundleSourceKind.zip,
        schema_version=1,
        validation_status=BundleValidationStatus.valid,
        errors=errors or [],
        warnings=warnings or [],
        completeness={
            "score": score,
            "bar": 80,
            "status": "meets_bar" if score >= 80 else "below_bar",
            "checks": checks or [],
        },
        manifest=None,
        uploaded_by=uploaded_by,
    )
    async with app.state.session_factory() as session:
        session.add(row)
        await session.commit()
    return row


def failing_check() -> dict[str, Any]:
    return {
        "id": "feature_examples",
        "label": "Every feature has an example",
        "passed": False,
        "weight": 20,
        "earned": 5,
        "detail": "4 features have no example",
        "fix_hint": "Add one example to each feature",
    }


def manifest_error() -> dict[str, Any]:
    return {
        "code": "missing",
        "message": "Field required",
        "severity": "error",
        "file": "manifest.yaml",
        "pointer": "/features/2/area",
        "line": 41,
        "column": 5,
    }


async def test_the_template_list_has_every_shipped_version_in_name_order(
    client: httpx.AsyncClient, viewer_headers: dict[str, str]
) -> None:
    response = await client.get(TEMPLATES_PATH, headers=viewer_headers)
    assert response.status_code == 200
    page = response.json()
    assert [(item["name"], item["version"]) for item in page["items"]] == LISTED_ORDER
    assert page["next_cursor"] is None
    assert page["total"] is None
    by_version = {(item["name"], item["version"]): item for item in page["items"]}
    for version in (1, 2):
        discovery = by_version[("discovery", version)]
        assert discovery["text"] == shipped_version_text("discovery", version)
        assert discovery["variables"] == ["SCHEMA_URL", "TARGET_TOKEN", "APP_KIND_HINTS"]
        assert discovery["created_at"].endswith("Z")


async def test_the_template_list_pages_and_counts(
    client: httpx.AsyncClient, viewer_headers: dict[str, str]
) -> None:
    first = (
        await client.get(
            TEMPLATES_PATH, params={"limit": 3, "include_total": True}, headers=viewer_headers
        )
    ).json()
    assert first["total"] == len(SHIPPED_VERSIONS)
    seen = [(item["name"], item["version"]) for item in first["items"]]
    assert len(seen) == 3
    cursor = first["next_cursor"]
    while cursor is not None:
        page = (
            await client.get(
                TEMPLATES_PATH, params={"limit": 3, "cursor": cursor}, headers=viewer_headers
            )
        ).json()
        seen.extend((item["name"], item["version"]) for item in page["items"])
        cursor = page["next_cursor"]
    assert seen == LISTED_ORDER


async def test_the_template_list_rejects_unknown_query_and_sort_keys(
    client: httpx.AsyncClient, viewer_headers: dict[str, str]
) -> None:
    response = await client.get(TEMPLATES_PATH, params={"bogus": 1}, headers=viewer_headers)
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["query", "bogus"]
    response = await client.get(TEMPLATES_PATH, params={"sort": "text"}, headers=viewer_headers)
    assert response.status_code == 422


async def test_one_template_is_read_by_name_and_defaults_to_the_current_version(
    client: httpx.AsyncClient, viewer_headers: dict[str, str]
) -> None:
    response = await client.get(f"{TEMPLATES_PATH}/fixup", headers=viewer_headers)
    assert response.status_code == 200
    template = response.json()
    assert template["name"] == "fixup"
    assert template["version"] == 1
    assert template["text"] == shipped_text("fixup")
    assert template["variables"][0] == "BUNDLE_VERSION"
    pinned = await client.get(
        f"{TEMPLATES_PATH}/fixup", params={"version": 1}, headers=viewer_headers
    )
    assert pinned.json() == template


@pytest.mark.usefixtures("restore_templates")
async def test_the_current_version_follows_is_current_and_old_versions_stay_readable(
    client: httpx.AsyncClient, viewer_headers: dict[str, str], db_app: FastAPI
) -> None:
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(PromptTemplateRow)
            .where(PromptTemplateRow.name == PromptTemplateName.fixup)
            .values(is_current=False)
        )
        session.add(
            PromptTemplateRow(
                name=PromptTemplateName.fixup,
                version=2,
                text="fix v2 {{TARGET_TOKEN}}",
                variables=["TARGET_TOKEN"],
                is_current=True,
            )
        )
        await session.commit()
    current = (await client.get(f"{TEMPLATES_PATH}/fixup", headers=viewer_headers)).json()
    assert (current["version"], current["text"]) == (2, "fix v2 {{TARGET_TOKEN}}")
    old = (
        await client.get(f"{TEMPLATES_PATH}/fixup", params={"version": 1}, headers=viewer_headers)
    ).json()
    assert old["text"] == shipped_text("fixup")


@pytest.mark.usefixtures("restore_templates")
async def test_a_missing_template_version_and_a_template_without_rows_are_404(
    client: httpx.AsyncClient, viewer_headers: dict[str, str], db_app: FastAPI
) -> None:
    missing_version = await client.get(
        f"{TEMPLATES_PATH}/discovery",
        params={"version": UNSHIPPED_DISCOVERY_VERSION},
        headers=viewer_headers,
    )
    assert missing_version.status_code == 404
    assert missing_version.json()["error"]["code"] == "not_found"
    async with db_app.state.session_factory() as session:
        await session.execute(
            delete(PromptTemplateRow).where(PromptTemplateRow.name == PromptTemplateName.propose)
        )
        await session.commit()
    no_rows = await client.get(f"{TEMPLATES_PATH}/propose", headers=viewer_headers)
    assert no_rows.status_code == 404


async def test_template_reads_validate_their_inputs_and_need_a_token(
    client: httpx.AsyncClient, viewer_headers: dict[str, str]
) -> None:
    assert (
        await client.get(f"{TEMPLATES_PATH}/nonsense", headers=viewer_headers)
    ).status_code == 422
    assert (
        await client.get(
            f"{TEMPLATES_PATH}/discovery", params={"version": 0}, headers=viewer_headers
        )
    ).status_code == 422
    assert (
        await client.get(f"{TEMPLATES_PATH}/discovery", params={"bogus": 1}, headers=viewer_headers)
    ).status_code == 422
    assert (await client.get(TEMPLATES_PATH)).status_code == 401
    assert (await client.get(f"{TEMPLATES_PATH}/discovery")).status_code == 401


async def test_a_discovery_prompt_carries_the_target_token_the_schema_url_and_the_hints(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    hint_ids = default_hint_ids(target_kind(target))
    response = await issue_discovery(client, member_headers, target["id"], hint_ids)
    assert response.status_code == 201
    issue = response.json()
    assert issue["target_id"] == target["id"]
    assert issue["template_name"] == "discovery"
    assert issue["template_version"] == CURRENT_VERSIONS["discovery"]
    assert issue["target_token"] == target["target_token"]
    assert issue["params"] == {
        "template_name": "discovery",
        "hint_ids": hint_ids,
        "template_version": None,
    }
    assert issue["issued_at"].endswith("Z")
    text = issue["text"]
    assert f"target_token {target['target_token']}" in text
    assert f"schema {SCHEMA_URL}" in text
    for instruction in hint_instructions(target_kind(target), hint_ids):
        assert f"- {instruction}" in text
    assert "{{SCHEMA_URL}}" not in text
    assert "{{TARGET_TOKEN}}" not in text
    assert "{{APP_KIND_HINTS}}" not in text
    assert "{{{{" not in text


def target_kind(target: dict[str, Any]) -> AppKind:
    return AppKind(target["app_kind"])


async def test_a_discovery_prompt_without_hint_ids_says_no_hints_were_selected(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    response = await client.post(
        issues_path(target["id"]), json={"template_name": "discovery"}, headers=member_headers
    )
    assert response.status_code == 201
    assert response.json()["params"] == {
        "template_name": "discovery",
        "hint_ids": [],
        "template_version": None,
    }
    assert "No app-specific instructions were selected." in response.json()["text"]


async def test_the_first_discovery_version_stays_issuable_on_request(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    response = await client.post(
        issues_path(target["id"]),
        json={"template_name": "discovery", "template_version": 1},
        headers=member_headers,
    )
    assert response.status_code == 201, response.text
    issue = response.json()
    assert issue["template_version"] == 1
    assert issue["params"]["template_version"] == 1
    assert f"target_token {target['target_token']}" in issue["text"]


async def test_duplicate_hint_ids_are_stored_once_and_rendered_once(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    first = known_hint_ids(target_kind(target))[0]
    response = await issue_discovery(client, member_headers, target["id"], [first, first])
    assert response.json()["params"]["hint_ids"] == [first]
    instruction = hint_instructions(target_kind(target), [first])[0]
    assert response.json()["text"].count(f"- {instruction}") == 1


async def test_an_unknown_hint_is_a_validation_error_with_its_position(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    response = await issue_discovery(
        client, member_headers, target["id"], [known_hint_ids(target_kind(target))[0], "teleport"]
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert error["details"][0]["loc"] == ["body", "hint_ids", 1]
    assert error["details"][0]["code"] == "unknown_hint"
    assert "teleport" in error["details"][0]["message"]


async def test_hints_belong_to_the_app_kind_of_the_target(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    api_target = await create_target(client, member_headers, name="Plain API", app_kind="api")
    llm_only_hint = known_hint_ids(target_kind({"app_kind": "llm_assistant"}))[0]
    response = await issue_discovery(client, member_headers, api_target["id"], [llm_only_hint])
    assert response.status_code == 422
    accepted = await issue_discovery(
        client, member_headers, api_target["id"], known_hint_ids(target_kind(api_target))
    )
    assert accepted.status_code == 201


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"template_name": "explain"},
        {"template_name": "nonsense"},
        {"template_name": "discovery", "hint_ids": "list_tools"},
        {"template_name": "discovery", "hint_ids": [1]},
        {"template_name": "fixup"},
        {"template_name": "fixup", "bundle_id": "not-a-uuid"},
    ],
)
async def test_malformed_prompt_requests_are_422(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    body: dict[str, Any],
) -> None:
    response = await client.post(issues_path(target["id"]), json=body, headers=member_headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"


async def test_only_members_issue_prompts_and_a_token_is_required(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
) -> None:
    denied = await issue_discovery(client, viewer_headers, target["id"])
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "role_required"
    anonymous = await client.post(issues_path(target["id"]), json={"template_name": "discovery"})
    assert anonymous.status_code == 401
    assert (
        await client.get(
            issues_path(target["id"]),
        )
    ).status_code == 401


async def test_a_prompt_for_an_unknown_or_archived_target_is_refused(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    target: dict[str, Any],
) -> None:
    unknown = await issue_discovery(client, member_headers, str(uuid.uuid4()))
    assert unknown.status_code == 404
    archived = await client.delete(f"{TARGETS_PATH}/{target['id']}", headers=admin_headers)
    assert archived.status_code == 204
    refused = await issue_discovery(client, member_headers, target["id"])
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "conflict"


async def test_a_reopened_prompt_is_byte_identical_to_the_issued_one(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
) -> None:
    created = await issue_discovery(
        client, member_headers, target["id"], known_hint_ids(target_kind(target))
    )
    issued = created.json()
    reopened = await client.get(f"{ISSUES_PATH}/{issued['id']}", headers=viewer_headers)
    assert reopened.status_code == 200
    assert reopened.json() == issued
    assert reopened.json()["text"].encode("utf-8") == issued["text"].encode("utf-8")


@pytest.mark.usefixtures("restore_templates")
async def test_a_reopened_prompt_survives_a_new_template_version_a_token_rotation_and_a_target_edit(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
) -> None:
    issued = (
        await issue_discovery(
            client, member_headers, target["id"], known_hint_ids(target_kind(target))
        )
    ).json()
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(PromptTemplateRow)
            .where(PromptTemplateRow.name == PromptTemplateName.discovery)
            .values(is_current=False)
        )
        session.add(
            PromptTemplateRow(
                name=PromptTemplateName.discovery,
                version=UNSHIPPED_DISCOVERY_VERSION,
                text="Version three {{TARGET_TOKEN}} {{SCHEMA_URL}} {{APP_KIND_HINTS}}",
                variables=["TARGET_TOKEN", "SCHEMA_URL", "APP_KIND_HINTS"],
                is_current=True,
            )
        )
        await session.commit()
    rotated = await client.post(
        f"{TARGETS_PATH}/{target['id']}/token/rotate", headers=member_headers
    )
    assert rotated.status_code == 200
    assert rotated.json()["target_token"] != target["target_token"]
    edited = await client.patch(
        f"{TARGETS_PATH}/{target['id']}", json={"name": "Renamed"}, headers=member_headers
    )
    assert edited.status_code == 200
    reopened = await client.get(f"{ISSUES_PATH}/{issued['id']}", headers=viewer_headers)
    assert reopened.json() == issued
    assert reopened.json()["template_version"] == CURRENT_VERSIONS["discovery"]
    assert reopened.json()["target_token"] == target["target_token"]
    renewed = (await issue_discovery(client, member_headers, target["id"])).json()
    assert renewed["template_version"] == UNSHIPPED_DISCOVERY_VERSION
    assert renewed["target_token"] == rotated.json()["target_token"]
    assert renewed["text"].startswith(
        f"Version three {rotated.json()['target_token']} {SCHEMA_URL}"
    )


async def test_a_prompt_issue_that_does_not_exist_is_404(
    client: httpx.AsyncClient, viewer_headers: dict[str, str]
) -> None:
    response = await client.get(f"{ISSUES_PATH}/{uuid.uuid4()}", headers=viewer_headers)
    assert response.status_code == 404
    assert (
        await client.get(f"{ISSUES_PATH}/{uuid.uuid4()}", params={"x": 1}, headers=viewer_headers)
    ).status_code == 422
    assert (
        await client.get(f"{ISSUES_PATH}/not-a-uuid", headers=viewer_headers)
    ).status_code == 422
    assert (await client.get(f"{ISSUES_PATH}/{uuid.uuid4()}")).status_code == 401


async def test_the_history_lists_newest_first_filters_by_template_and_pages(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
    make_user: MakeUser,
) -> None:
    uploader = await make_user(UserRole.member)
    bundle = await insert_bundle_row(db_app, target["id"], uploader.id)
    first = (await issue_discovery(client, member_headers, target["id"])).json()
    second = (await issue_discovery(client, member_headers, target["id"])).json()
    fixup = await client.post(
        issues_path(target["id"]),
        json={"template_name": "fixup", "bundle_id": str(bundle.id)},
        headers=member_headers,
    )
    assert fixup.status_code == 201
    listed = (await client.get(issues_path(target["id"]), headers=viewer_headers)).json()
    assert [item["id"] for item in listed["items"]] == [
        fixup.json()["id"],
        second["id"],
        first["id"],
    ]
    only_discovery = (
        await client.get(
            issues_path(target["id"]),
            params={"template_name": "discovery", "include_total": True},
            headers=viewer_headers,
        )
    ).json()
    assert [item["id"] for item in only_discovery["items"]] == [second["id"], first["id"]]
    assert only_discovery["total"] == 2
    both = (
        await client.get(
            issues_path(target["id"]),
            params=[("template_name", "discovery"), ("template_name", "fixup")],
            headers=viewer_headers,
        )
    ).json()
    assert len(both["items"]) == 3
    page = (
        await client.get(issues_path(target["id"]), params={"limit": 2}, headers=viewer_headers)
    ).json()
    assert len(page["items"]) == 2
    rest = (
        await client.get(
            issues_path(target["id"]),
            params={"limit": 2, "cursor": page["next_cursor"]},
            headers=viewer_headers,
        )
    ).json()
    assert [item["id"] for item in rest["items"]] == [first["id"]]
    assert rest["next_cursor"] is None


async def test_the_history_is_per_target_and_rejects_bad_filters(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    other = await create_target(client, member_headers, name="Other")
    await issue_discovery(client, member_headers, target["id"])
    assert (await client.get(issues_path(other["id"]), headers=member_headers)).json()[
        "items"
    ] == []
    assert (
        await client.get(
            issues_path(target["id"]), params={"template_name": "nonsense"}, headers=member_headers
        )
    ).status_code == 422
    assert (
        await client.get(issues_path(target["id"]), params={"sort": "text"}, headers=member_headers)
    ).status_code == 422
    assert (
        await client.get(issues_path(str(uuid.uuid4())), headers=member_headers)
    ).status_code == 404


async def test_an_archived_targets_history_stays_readable(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    admin_headers: dict[str, str],
    target: dict[str, Any],
) -> None:
    await issue_discovery(client, member_headers, target["id"])
    await client.delete(f"{TARGETS_PATH}/{target['id']}", headers=admin_headers)
    response = await client.get(issues_path(target["id"]), headers=member_headers)
    assert response.status_code == 200
    assert len(response.json()["items"]) == 1


async def test_the_same_idempotency_key_replays_the_first_prompt_without_a_second_row(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
) -> None:
    key = {IDEMPOTENCY_HEADER: "prompt-key-0001"}
    first = await issue_discovery(client, member_headers, target["id"], ["list_tools"], **key)
    second = await issue_discovery(client, member_headers, target["id"], ["list_tools"], **key)
    assert first.status_code == second.status_code == 201
    assert "idempotency-replayed" not in first.headers
    assert second.headers["idempotency-replayed"] == "true"
    assert second.json() == first.json()
    async with db_app.state.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(PromptIssueRow))
    assert count == 1


async def test_the_same_key_with_a_different_body_is_a_conflict(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    key = {IDEMPOTENCY_HEADER: "prompt-key-0002"}
    await issue_discovery(client, member_headers, target["id"], [], **key)
    other = await issue_discovery(client, member_headers, target["id"], ["list_tools"], **key)
    assert other.status_code == 409
    assert other.json()["error"]["code"] == "idempotency_conflict"


async def test_without_a_key_every_request_issues_a_new_prompt(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
) -> None:
    first = await issue_discovery(client, member_headers, target["id"])
    second = await issue_discovery(client, member_headers, target["id"])
    assert first.json()["id"] != second.json()["id"]
    assert first.json()["text"] == second.json()["text"]
    async with db_app.state.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(PromptIssueRow))
    assert count == 2


async def test_a_failed_request_releases_its_key_so_a_corrected_retry_succeeds(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    key = {IDEMPOTENCY_HEADER: "prompt-key-0003"}
    failed = await issue_discovery(client, member_headers, target["id"], ["teleport"], **key)
    assert failed.status_code == 422
    retried = await issue_discovery(client, member_headers, target["id"], ["teleport"], **key)
    assert retried.status_code == 422
    assert retried.json()["error"]["code"] == "validation_failed"


async def test_a_malformed_idempotency_key_is_rejected(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    response = await client.post(
        issues_path(target["id"]),
        json={"template_name": "discovery"},
        headers={**member_headers, IDEMPOTENCY_HEADER: "short"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "idempotency_key_required"


async def test_a_fixup_prompt_lists_the_open_items_of_the_bundle(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
    make_user: MakeUser,
) -> None:
    uploader = await make_user(UserRole.member)
    bundle = await insert_bundle_row(
        db_app,
        target["id"],
        uploader.id,
        version=3,
        score=62,
        errors=[manifest_error()],
        checks=[failing_check()],
    )
    response = await client.post(
        issues_path(target["id"]),
        json={"template_name": "fixup", "bundle_id": str(bundle.id)},
        headers=member_headers,
    )
    assert response.status_code == 201
    issue = response.json()
    assert issue["template_name"] == "fixup"
    assert issue["template_version"] == 1
    assert issue["target_token"] == target["target_token"]
    assert issue["params"] == {"template_name": "fixup", "bundle_id": str(bundle.id)}
    text = issue["text"]
    assert "validated version 3 of the bundle" in text
    assert f"schema {SCHEMA_URL}" in text
    assert target["target_token"] in text
    assert "scored its completeness 62 out of 100" in text
    assert "1. [error] manifest.yaml, /features/2/area, line 41: missing: Field required" in text
    assert "feature_examples" in text
    assert "To fix: Add one example to each feature" in text
    assert "{{" not in text.replace("{{ rows | length }}", "")
    reopened = await client.get(f"{ISSUES_PATH}/{issue['id']}", headers=viewer_headers)
    assert reopened.json() == issue
    async with db_app.state.session_factory() as session:
        row = await session.get(PromptIssueRow, uuid.UUID(issue["id"]))
    assert row is not None
    assert row.bundle_id == bundle.id


async def test_a_fixup_prompt_for_a_bundle_at_the_bar_still_renders(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
    make_user: MakeUser,
) -> None:
    uploader = await make_user(UserRole.member)
    bundle = await insert_bundle_row(
        db_app,
        target["id"],
        uploader.id,
        score=100,
        warnings=[
            {
                "code": "file_ignored",
                "message": "Binary file dropped",
                "severity": "warning",
                "file": "seeds/dump.bin",
            }
        ],
    )
    response = await client.post(
        issues_path(target["id"]),
        json={"template_name": "fixup", "bundle_id": str(bundle.id)},
        headers=member_headers,
    )
    assert response.status_code == 201
    assert (
        "1. [warning] seeds/dump.bin: file_ignored: Binary file dropped" in response.json()["text"]
    )


async def test_a_fixup_prompt_with_nothing_open_says_so(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
    make_user: MakeUser,
) -> None:
    uploader = await make_user(UserRole.member)
    bundle = await insert_bundle_row(db_app, target["id"], uploader.id, score=100)
    response = await client.post(
        issues_path(target["id"]),
        json={"template_name": "fixup", "bundle_id": str(bundle.id)},
        headers=member_headers,
    )
    assert "Nothing is open" in response.json()["text"]


async def test_a_fixup_prompt_needs_a_bundle_of_the_same_target(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
    make_user: MakeUser,
) -> None:
    uploader = await make_user(UserRole.member)
    other = await create_target(client, member_headers, name="Other")
    foreign_bundle = await insert_bundle_row(db_app, other["id"], uploader.id)
    for bundle_id in (uuid.uuid4(), foreign_bundle.id):
        response = await client.post(
            issues_path(target["id"]),
            json={"template_name": "fixup", "bundle_id": str(bundle_id)},
            headers=member_headers,
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"


async def test_prompt_issue_text_is_never_stored_with_an_unresolved_placeholder(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
) -> None:
    await issue_discovery(client, member_headers, target["id"], known_hint_ids(target_kind(target)))
    async with db_app.state.session_factory() as session:
        texts = (await session.scalars(select(PromptIssueRow.text))).all()
    assert texts
    for text in texts:
        assert "{{" not in text.replace("{{ rows | length }}", "")


@pytest.mark.usefixtures("restore_templates")
async def test_a_template_that_cannot_render_is_a_server_error_and_stores_nothing(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
) -> None:
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(PromptTemplateRow)
            .where(PromptTemplateRow.name == PromptTemplateName.discovery)
            .values(text="Broken {{SCHEMA_URL}} {{TARGET_TOKEN}} {{APP_KIND_HINTS}} {{OTHER}}")
        )
        await session.commit()
    response = await issue_discovery(client, member_headers, target["id"])
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert "OTHER" in response.json()["error"]["message"]
    async with db_app.state.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(PromptIssueRow))
    assert count == 0
