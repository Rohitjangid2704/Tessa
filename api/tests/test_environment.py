import logging
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from tessa_api.db.models import EnvironmentRow
from tessa_api.schemas.enums import EnvVarKind, HealthCheckStatus, UserRole
from tessa_api.schemas.environment import EnvironmentVariable
from tessa_api.schemas.health import HealthState
from tessa_api.services.environment import (
    DeclaredVariable,
    ReconcileResult,
    infer_kind,
    reconcile_environment,
    resolve_values,
)
from tessa_api.services.vault import Vault, vault_from_settings
from tessa_api.settings import Settings
from tests.stage_one import TARGETS_PATH, create_target, environment_path
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

SECRET_DSN = "postgresql://qa_reader:Zx9-hunter2-Qq@db.internal:5432/app"
SECRET_TOKEN = "tok_live_51Habcdef0123456789"


@pytest.fixture
async def member_headers(db_app: FastAPI, make_user: MakeUser, auth_headers: AuthHeaders) -> Any:
    return auth_headers(await make_user(UserRole.member))


@pytest.fixture
async def target_id(client: httpx.AsyncClient, member_headers: dict[str, str]) -> str:
    return str((await create_target(client, member_headers))["id"])


@pytest.fixture
def vault(settings: Settings) -> Vault:
    return vault_from_settings(settings)


async def reconcile(app: FastAPI, target: str, *variables: DeclaredVariable) -> ReconcileResult:
    async with app.state.session_factory() as session:
        result = await reconcile_environment(session, uuid.UUID(target), variables)
        await session.commit()
    return result


async def read_rows(app: FastAPI, target: str) -> dict[str, EnvironmentRow]:
    async with app.state.session_factory() as session:
        rows = (
            await session.scalars(
                select(EnvironmentRow).where(EnvironmentRow.target_id == uuid.UUID(target))
            )
        ).all()
    return {row.name: row for row in rows}


async def read_list(
    client: httpx.AsyncClient, headers: dict[str, str], target: str
) -> dict[str, Any]:
    response = await client.get(environment_path(target), headers=headers)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def by_name(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["name"]: item for item in body["items"]}


@pytest.mark.parametrize(
    ("name", "kind"),
    [
        ("GRACIE_BASE_URL", EnvVarKind.url),
        ("TRUTH_DB_DSN", EnvVarKind.dsn),
        ("ADMIN_TOKEN", EnvVarKind.token),
        ("ADMIN_PASSWORD", EnvVarKind.password),
        ("OPENAI_API_KEY", EnvVarKind.token),
        ("WEBHOOK_SECRET", EnvVarKind.token),
        ("TENANT_ID", EnvVarKind.string),
        ("URL_PREFIX", EnvVarKind.string),
        ("lower_url", EnvVarKind.url),
    ],
)
def test_kind_is_inferred_from_the_name_suffix(name: str, kind: EnvVarKind) -> None:
    assert infer_kind(name) is kind


async def test_new_names_appear_without_a_value_and_with_inferred_kinds(
    db_app: FastAPI, target_id: str
) -> None:
    result = await reconcile(
        db_app,
        target_id,
        DeclaredVariable(
            "GRACIE_BASE_URL",
            kind="url",
            secret=False,
            purpose="Base URL of QA",
            interfaces=("chat_sse", "browser"),
        ),
        DeclaredVariable("ADMIN_PASSWORD", required=False),
        DeclaredVariable("TENANT_ID"),
    )
    assert result == ReconcileResult(
        created=("GRACIE_BASE_URL", "ADMIN_PASSWORD", "TENANT_ID"), updated=(), stale=()
    )
    rows = await read_rows(db_app, target_id)
    base = rows["GRACIE_BASE_URL"]
    assert (base.kind, base.secret, base.required) == (EnvVarKind.url, False, True)
    assert base.purpose == "Base URL of QA"
    assert base.interface_ids == ["chat_sse", "browser"]
    assert base.encrypted_value is None
    assert base.stale is False
    password = rows["ADMIN_PASSWORD"]
    assert (password.kind, password.secret, password.required) == (EnvVarKind.password, True, False)
    tenant = rows["TENANT_ID"]
    assert (tenant.kind, tenant.secret) == (EnvVarKind.string, True)


async def test_declared_kind_wins_over_the_name_and_an_unknown_kind_falls_back_to_it(
    db_app: FastAPI, target_id: str
) -> None:
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("SHOP_URL", kind="number", secret=False),
        DeclaredVariable("EDGE_URL", kind="hologram"),
    )
    rows = await read_rows(db_app, target_id)
    assert rows["SHOP_URL"].kind is EnvVarKind.number
    assert rows["EDGE_URL"].kind is EnvVarKind.url


@pytest.mark.parametrize("kind", ["dsn", "token", "password"])
async def test_dsn_token_and_password_are_always_secret(
    db_app: FastAPI, target_id: str, kind: str
) -> None:
    await reconcile(db_app, target_id, DeclaredVariable("THING", kind=kind, secret=False))
    assert (await read_rows(db_app, target_id))["THING"].secret is True


async def test_removed_names_turn_stale_and_keep_their_value_until_declared_again(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(
        db_app, target_id, DeclaredVariable("KEEP_TOKEN"), DeclaredVariable("DROP_TOKEN")
    )
    await client.patch(
        environment_path(target_id),
        json={"set": {"DROP_TOKEN": SECRET_TOKEN}},
        headers=member_headers,
    )
    second = await reconcile(db_app, target_id, DeclaredVariable("KEEP_TOKEN"))
    assert second == ReconcileResult(created=(), updated=("KEEP_TOKEN",), stale=("DROP_TOKEN",))
    listed = by_name(await read_list(client, member_headers, target_id))
    assert listed["DROP_TOKEN"]["stale"] is True
    assert listed["DROP_TOKEN"]["has_value"] is True
    assert listed["KEEP_TOKEN"]["stale"] is False
    third = await reconcile(db_app, target_id, DeclaredVariable("KEEP_TOKEN"))
    assert third.stale == ()
    back = await reconcile(
        db_app, target_id, DeclaredVariable("KEEP_TOKEN"), DeclaredVariable("DROP_TOKEN")
    )
    assert back.updated == ("KEEP_TOKEN", "DROP_TOKEN")
    again = by_name(await read_list(client, member_headers, target_id))
    assert again["DROP_TOKEN"]["stale"] is False
    assert again["DROP_TOKEN"]["has_value"] is True


async def test_reconcile_updates_metadata_and_merges_duplicate_declarations(
    db_app: FastAPI, target_id: str
) -> None:
    await reconcile(db_app, target_id, DeclaredVariable("API_URL", purpose="old", required=False))
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("API_URL", kind="url", secret=False, purpose="new", interfaces=("a",)),
        DeclaredVariable("API_URL", interfaces=("a", "b"), required=True),
    )
    row = (await read_rows(db_app, target_id))["API_URL"]
    assert (row.purpose, row.required, row.secret) == ("new", True, False)
    assert row.interface_ids == ["a", "b"]


async def test_a_secret_with_a_value_is_never_downgraded_by_a_bundle(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(db_app, target_id, DeclaredVariable("EDGE_URL", kind="url"))
    await client.patch(
        environment_path(target_id),
        json={"set": {"EDGE_URL": "https://edge.example.com/?key=abc123"}},
        headers=member_headers,
    )
    await reconcile(db_app, target_id, DeclaredVariable("EDGE_URL", kind="url", secret=False))
    listed = by_name(await read_list(client, member_headers, target_id))
    assert listed["EDGE_URL"]["secret"] is True
    assert listed["EDGE_URL"]["value"] is None
    await client.patch(
        environment_path(target_id), json={"clear": ["EDGE_URL"]}, headers=member_headers
    )
    await reconcile(db_app, target_id, DeclaredVariable("EDGE_URL", kind="url", secret=False))
    assert (await read_rows(db_app, target_id))["EDGE_URL"].secret is False


async def test_invalid_names_are_refused(db_app: FastAPI, target_id: str) -> None:
    with pytest.raises(ValueError, match="not valid"):
        await reconcile(db_app, target_id, DeclaredVariable("lower-case"))


async def test_listing_and_patching_follow_roles(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(db_app, target_id, DeclaredVariable("X_TOKEN"))
    viewer = auth_headers(await make_user(UserRole.viewer))
    assert (await client.get(environment_path(target_id))).status_code == 401
    assert (await client.get(environment_path(target_id), headers=viewer)).status_code == 200
    denied = await client.patch(
        environment_path(target_id), json={"set": {"X_TOKEN": "abcd1234"}}, headers=viewer
    )
    assert denied.status_code == 403
    missing = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11"
    assert (await client.get(environment_path(missing), headers=member_headers)).status_code == 404
    assert (
        await client.patch(environment_path(missing), json={}, headers=member_headers)
    ).status_code == 404


async def test_archived_targets_refuse_environment_changes(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    admin = auth_headers(await make_user(UserRole.admin))
    await client.delete(f"{TARGETS_PATH}/{target_id}", headers=admin)
    response = await client.patch(environment_path(target_id), json={}, headers=member_headers)
    assert response.status_code == 409


async def test_patch_stores_values_encrypted_and_never_returns_a_secret(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    vault: Vault,
    target_id: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    member = await make_user(UserRole.member)
    headers = auth_headers(member)
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("TRUTH_DB_DSN", kind="dsn"),
        DeclaredVariable("ADMIN_TOKEN"),
        DeclaredVariable("GRACIE_BASE_URL", kind="url", secret=False),
        DeclaredVariable("MAX_ROWS", kind="number", secret=False),
        DeclaredVariable("DEBUG_FLAG", kind="bool", secret=False),
        DeclaredVariable("OPTIONAL_NOTE", kind="string", required=False),
    )
    caplog.set_level(logging.DEBUG)
    response = await client.patch(
        environment_path(target_id),
        json={
            "set": {
                "TRUTH_DB_DSN": SECRET_DSN,
                "ADMIN_TOKEN": SECRET_TOKEN,
                "GRACIE_BASE_URL": "https://qa.gracie.example.com",
                "MAX_ROWS": "250",
                "DEBUG_FLAG": "TRUE",
            }
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    follow_up = await client.get(environment_path(target_id), headers=headers)

    for text in (response.text, follow_up.text, caplog.text):
        assert SECRET_DSN not in text
        assert "Zx9-hunter2" not in text
        assert SECRET_TOKEN not in text

    listed = by_name(response.json())
    assert listed["TRUTH_DB_DSN"]["has_value"] is True
    assert listed["TRUTH_DB_DSN"]["value"] is None
    assert listed["ADMIN_TOKEN"]["value"] is None
    assert listed["GRACIE_BASE_URL"]["value"] == "https://qa.gracie.example.com"
    assert listed["MAX_ROWS"]["value"] == "250"
    assert listed["DEBUG_FLAG"]["value"] == "true"
    assert listed["OPTIONAL_NOTE"]["has_value"] is False
    assert listed["OPTIONAL_NOTE"]["value"] is None
    assert listed["ADMIN_TOKEN"]["last_set_by"] == str(member.id)
    assert listed["ADMIN_TOKEN"]["last_set_at"].endswith("Z")
    assert listed["OPTIONAL_NOTE"]["last_set_at"] is None
    assert follow_up.json() == response.json()
    assert response.json()["missing_required"] == 0

    rows = await read_rows(db_app, target_id)
    for row in rows.values():
        if row.encrypted_value is not None:
            assert b"hunter2" not in row.encrypted_value
            assert b"tok_live" not in row.encrypted_value
            assert b"qa.gracie" not in row.encrypted_value
    assert rows["TRUTH_DB_DSN"].encrypted_value is not None
    assert vault.decrypt(rows["TRUTH_DB_DSN"].encrypted_value).get_secret_value() == SECRET_DSN


async def test_clearing_removes_the_value_and_resets_health(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(db_app, target_id, DeclaredVariable("ADMIN_TOKEN"))
    await client.patch(
        environment_path(target_id),
        json={"set": {"ADMIN_TOKEN": SECRET_TOKEN}},
        headers=member_headers,
    )
    async with db_app.state.session_factory() as session:
        row = await session.scalar(
            select(EnvironmentRow).where(EnvironmentRow.name == "ADMIN_TOKEN")
        )
        assert row is not None
        row.last_health = HealthState(
            status=HealthCheckStatus.ok, checked_at=row.last_set_at, latency_ms=5, message="ok"
        ).model_dump(mode="json")
        await session.commit()
    listed = by_name(await read_list(client, member_headers, target_id))
    assert listed["ADMIN_TOKEN"]["health"]["status"] == "ok"

    cleared = await client.patch(
        environment_path(target_id), json={"clear": ["ADMIN_TOKEN"]}, headers=member_headers
    )
    item = by_name(cleared.json())["ADMIN_TOKEN"]
    assert item["has_value"] is False
    assert item["health"] == {
        "status": "unchecked",
        "checked_at": None,
        "latency_ms": None,
        "message": None,
    }
    assert (await read_rows(db_app, target_id))["ADMIN_TOKEN"].encrypted_value is None


async def test_missing_required_counts_only_current_required_names_without_values(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("A_TOKEN"),
        DeclaredVariable("B_TOKEN"),
        DeclaredVariable("C_NOTE", required=False),
        DeclaredVariable("OLD_TOKEN"),
    )
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("A_TOKEN"),
        DeclaredVariable("B_TOKEN"),
        DeclaredVariable("C_NOTE", required=False),
    )
    assert (await read_list(client, member_headers, target_id))["missing_required"] == 2
    await client.patch(
        environment_path(target_id), json={"set": {"A_TOKEN": "aaaa1111"}}, headers=member_headers
    )
    assert (await read_list(client, member_headers, target_id))["missing_required"] == 1
    listed = await read_list(client, member_headers, target_id)
    assert [item["name"] for item in listed["items"]] == [
        "A_TOKEN",
        "B_TOKEN",
        "C_NOTE",
        "OLD_TOKEN",
    ]


async def test_a_url_with_userinfo_cannot_be_stored_as_a_plain_variable(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("PLAIN_URL", kind="url", secret=False),
        DeclaredVariable("HIDDEN_URL", kind="url", secret=True),
    )
    refused = await client.patch(
        environment_path(target_id),
        json={"set": {"PLAIN_URL": "https://reader:pa55word@host.example.com/api"}},
        headers=member_headers,
    )
    assert refused.status_code == 422
    detail = refused.json()["error"]["details"][0]
    assert detail["loc"] == ["body", "set", "PLAIN_URL"]
    assert detail["code"] == "url_with_userinfo_not_allowed"
    assert "pa55word" not in refused.text

    accepted = await client.patch(
        environment_path(target_id),
        json={"set": {"HIDDEN_URL": "https://reader:pa55word@host.example.com/api"}},
        headers=member_headers,
    )
    assert accepted.status_code == 200
    assert "pa55word" not in accepted.text
    assert by_name(accepted.json())["HIDDEN_URL"]["value"] is None
    userless = await client.patch(
        environment_path(target_id),
        json={"set": {"PLAIN_URL": "https://host.example.com/api"}},
        headers=member_headers,
    )
    assert userless.status_code == 200


async def test_values_are_checked_against_the_kind(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("SOME_URL", kind="url", secret=False),
        DeclaredVariable("SOME_DSN", kind="dsn"),
        DeclaredVariable("SOME_NUMBER", kind="number", secret=False),
        DeclaredVariable("SOME_BOOL", kind="bool", secret=False),
    )
    for name, value in (
        ("SOME_URL", "not a url"),
        ("SOME_DSN", "host=db dbname=app"),
        ("SOME_NUMBER", "twelve"),
        ("SOME_NUMBER", "nan"),
        ("SOME_BOOL", "maybe"),
    ):
        response = await client.patch(
            environment_path(target_id), json={"set": {name: value}}, headers=member_headers
        )
        assert response.status_code == 422, (name, value)
        detail = response.json()["error"]["details"][0]
        assert detail["loc"] == ["body", "set", name]
        assert detail["code"] == "invalid_value"
        assert value not in response.text


async def test_patch_problems_name_the_offending_entries(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
) -> None:
    await reconcile(db_app, target_id, DeclaredVariable("REAL_TOKEN"))
    response = await client.patch(
        environment_path(target_id),
        json={
            "set": {"REAL_TOKEN": "abcd1234", "GHOST_TOKEN": "xxxx9999"},
            "clear": ["REAL_TOKEN", "GHOST_CLEAR"],
        },
        headers=member_headers,
    )
    assert response.status_code == 422
    details = {(tuple(d["loc"]), d["code"]) for d in response.json()["error"]["details"]}
    assert (("body", "set", "GHOST_TOKEN"), "unknown_variable") in details
    assert (("body", "set", "REAL_TOKEN"), "conflicting_operation") in details
    assert (("body", "clear", 1), "unknown_variable") in details
    assert "xxxx9999" not in response.text
    rows = await read_rows(db_app, target_id)
    assert rows["REAL_TOKEN"].encrypted_value is None


@pytest.mark.parametrize(
    "value",
    [pytest.param("", id="empty"), pytest.param("x" * 65537, id="oversized")],
)
async def test_empty_and_oversized_values_are_rejected(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    target_id: str,
    value: str,
) -> None:
    await reconcile(db_app, target_id, DeclaredVariable("REAL_TOKEN"))
    response = await client.patch(
        environment_path(target_id), json={"set": {"REAL_TOKEN": value}}, headers=member_headers
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"][:2] == ["body", "set"]


async def test_resolve_values_returns_secret_strings_for_current_names(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    member_headers: dict[str, str],
    vault: Vault,
    target_id: str,
) -> None:
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("TRUTH_DB_DSN", kind="dsn"),
        DeclaredVariable("ADMIN_TOKEN"),
        DeclaredVariable("OLD_TOKEN"),
        DeclaredVariable("EMPTY_TOKEN"),
    )
    await client.patch(
        environment_path(target_id),
        json={
            "set": {
                "TRUTH_DB_DSN": SECRET_DSN,
                "ADMIN_TOKEN": SECRET_TOKEN,
                "OLD_TOKEN": "oldoldold",
            }
        },
        headers=member_headers,
    )
    await reconcile(
        db_app,
        target_id,
        DeclaredVariable("TRUTH_DB_DSN", kind="dsn"),
        DeclaredVariable("ADMIN_TOKEN"),
        DeclaredVariable("EMPTY_TOKEN"),
    )
    async with db_app.state.session_factory() as session:
        resolved = await resolve_values(session, vault, uuid.UUID(target_id))
        only_token = await resolve_values(
            session, vault, uuid.UUID(target_id), names=["ADMIN_TOKEN"]
        )
        with_stale = await resolve_values(session, vault, uuid.UUID(target_id), include_stale=True)
    assert set(resolved) == {"TRUTH_DB_DSN", "ADMIN_TOKEN"}
    assert resolved["TRUTH_DB_DSN"].get_secret_value() == SECRET_DSN
    assert SECRET_DSN not in repr(resolved)
    assert set(only_token) == {"ADMIN_TOKEN"}
    assert set(with_stale) == {"TRUTH_DB_DSN", "ADMIN_TOKEN", "OLD_TOKEN"}


def test_the_response_model_refuses_to_carry_a_secret_value() -> None:
    health = HealthState(
        status=HealthCheckStatus.unchecked, checked_at=None, latency_ms=None, message=None
    )
    fields: dict[str, Any] = {
        "name": "ADMIN_TOKEN",
        "kind": EnvVarKind.token,
        "required": True,
        "purpose": "",
        "interface_ids": [],
        "has_value": True,
        "stale": False,
        "last_set_at": None,
        "last_set_by": None,
        "health": health,
    }
    with pytest.raises(ValueError, match="never carries its value"):
        EnvironmentVariable(secret=True, value=SECRET_TOKEN, **fields)
    plain = EnvironmentVariable(secret=False, value="visible", **fields)
    assert plain.model_dump()["value"] == "visible"
    hidden = EnvironmentVariable(secret=True, value=None, **fields)
    assert SECRET_TOKEN not in hidden.model_dump_json()
