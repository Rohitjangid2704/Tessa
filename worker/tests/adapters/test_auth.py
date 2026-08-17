import base64
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from tessa_api.schemas.enums import EnvVarKind
from tessa_worker.adapters.auth import (
    AccessResolver,
    EnvironmentValue,
    ResolvedEnvironment,
    credential_field,
    extract_token,
    load_environment,
    sanitize_name,
)
from tessa_worker.adapters.context import resolve_interface
from tessa_worker.adapters.errors import (
    CredentialsUnavailableError,
    InterfaceUnresolvedError,
    MissingPlaceholderError,
)
from tests.adapters.support import RegisteredTarget, environment_of, minimal_manifest
from tests.fake_target.dataset import (
    ADMIN_TOKEN,
    MANAGER_TOKEN,
    STAFF_EMAIL,
    STAFF_PASSWORD,
)


def api_interface(auth: dict[str, Any] | None, interface_id: str = "api") -> dict[str, Any]:
    interface: dict[str, Any] = {"id": interface_id, "kind": "http", "base_path": "/api"}
    if auth is not None:
        interface["auth"] = auth
    return interface


def resolver(
    auth: dict[str, Any] | None,
    environment: ResolvedEnvironment,
    roles: list[dict[str, Any]] | None = None,
) -> AccessResolver:
    return AccessResolver(minimal_manifest([api_interface(auth)], roles), environment)


def test_a_placeholder_is_replaced_by_the_value_and_a_missing_one_is_named() -> None:
    environment = environment_of(UNIT_TOKEN="tok-1")
    assert environment.substitute("Bearer ${UNIT_TOKEN}!") == "Bearer tok-1!"
    with pytest.raises(MissingPlaceholderError, match="NOPE") as caught:
        environment.substitute("${UNIT_TOKEN} ${NOPE}")
    assert caught.value.name == "NOPE"


def test_text_without_placeholders_and_lowercase_braces_are_left_alone() -> None:
    environment = environment_of(UNIT_TOKEN="tok-1")
    assert environment.substitute("price $5 ${gold.value} {UNIT_TOKEN}") == (
        "price $5 ${gold.value} {UNIT_TOKEN}"
    )


def test_placeholders_are_replaced_inside_nested_json() -> None:
    environment = environment_of(A_VALUE="1", B_VALUE="2")
    assert environment.substitute_json(
        {"x": ["${A_VALUE}", {"y": "${B_VALUE}"}], "n": 3, "t": None}
    ) == {"x": ["1", {"y": "2"}], "n": 3, "t": None}


def test_only_secret_variables_are_handed_to_the_redactor() -> None:
    environment = ResolvedEnvironment(
        [
            EnvironmentValue("PUBLIC_URL", EnvVarKind.url, False, (), "http://x"),
            EnvironmentValue("SECRET_ONE", EnvVarKind.token, True, (), "tok-secret-1"),
        ]
    )
    assert environment.secrets() == {"SECRET_ONE": "tok-secret-1"}
    redactor = environment.new_redactor()
    assert redactor.redact_text("http://x tok-secret-1") == "http://x ${SECRET_ONE}"


def test_a_value_is_not_shown_in_the_repr() -> None:
    value = EnvironmentValue("NAME_ONE", EnvVarKind.token, True, (), "tok-secret-1")
    assert "tok-secret-1" not in repr(value)


def test_a_bearer_token_source_that_is_one_placeholder_becomes_a_static_header() -> None:
    access = resolver(
        {"type": "bearer", "token_source": {"staff": "${STAFF_TOKEN}"}},
        environment_of(STAFF_TOKEN="tok-abc"),
    ).resolve("api", "staff")
    assert access.headers == {"Authorization": "Bearer tok-abc"}
    assert access.login is None
    assert "tok-abc" not in repr(access)


def test_the_auth_header_name_comes_from_the_interface() -> None:
    access = resolver(
        {"type": "bearer", "header": "X-Auth", "token_source": {"staff": "${STAFF_TOKEN}"}},
        environment_of(STAFF_TOKEN="tok-abc"),
    ).resolve("api", "staff")
    assert access.headers == {"X-Auth": "Bearer tok-abc"}


def test_an_api_key_is_sent_raw_in_its_header_with_a_default_name() -> None:
    environment = environment_of(KEY_VALUE="key-1")
    source = {"staff": "${KEY_VALUE}"}
    default = resolver({"type": "api_key", "token_source": source}, environment).resolve(
        "api", "staff"
    )
    named = resolver(
        {"type": "api_key", "header": "X-Key", "token_source": source}, environment
    ).resolve("api", "staff")
    assert default.headers == {"X-API-Key": "key-1"}
    assert named.headers == {"X-Key": "key-1"}


def test_a_login_request_with_credential_placeholders_builds_a_json_body() -> None:
    access = resolver(
        {
            "type": "bearer",
            "token_source": {
                "staff": "POST /api/auth/login with ${STAFF_EMAIL} and ${STAFF_PASSWORD}"
            },
        },
        environment_of(STAFF_EMAIL="a@b.test", STAFF_PASSWORD="pw-1"),
    ).resolve("api", "staff")
    assert access.headers == {}
    assert access.login is not None
    assert access.login.method == "POST"
    assert access.login.path == "/api/auth/login"
    assert access.login.body == {"email": "a@b.test", "password": "pw-1"}
    assert access.token_header == "Authorization"
    assert access.token_prefix == "Bearer "
    assert "pw-1" not in repr(access)


def test_a_login_request_can_spell_its_json_body() -> None:
    access = resolver(
        {
            "type": "bearer",
            "token_source": {
                "staff": 'POST /login {"user": "${U_NAME}", "pass": "${P_WORD}", "n": 1}'
            },
        },
        environment_of(U_NAME="bob", P_WORD="s3"),
    ).resolve("api", "staff")
    assert access.login is not None
    assert access.login.body == {"user": "bob", "pass": "s3", "n": 1}


def test_a_login_request_without_credentials_has_no_body() -> None:
    access = resolver(
        {"type": "bearer", "token_source": {"staff": "GET /api/session"}}, environment_of()
    ).resolve("api", "staff")
    assert access.login is not None
    assert access.login.method == "GET"
    assert access.login.body is None


def test_an_invalid_login_body_is_refused() -> None:
    with pytest.raises(CredentialsUnavailableError, match="JSON"):
        resolver(
            {"type": "bearer", "token_source": {"staff": "POST /login {not json"}}, environment_of()
        ).resolve("api", "staff")


def test_a_token_source_that_is_neither_a_placeholder_nor_a_login_is_refused() -> None:
    with pytest.raises(CredentialsUnavailableError, match="placeholder"):
        resolver(
            {"type": "bearer", "token_source": {"staff": "ask the admin"}}, environment_of()
        ).resolve("api", "staff")


def test_the_role_credential_variable_is_the_fallback_when_it_holds_a_token() -> None:
    roles = [{"id": "staff", "level": 1, "description": "Staff", "credential_env": "STAFF_TOKEN"}]
    access = resolver({"type": "bearer"}, environment_of(STAFF_TOKEN="tok-xyz"), roles).resolve(
        "api", "staff"
    )
    assert access.headers == {"Authorization": "Bearer tok-xyz"}


def test_a_password_credential_variable_is_not_a_token_fallback() -> None:
    roles = [
        {"id": "staff", "level": 1, "description": "Staff", "credential_env": "STAFF_PASSWORD"}
    ]
    with pytest.raises(CredentialsUnavailableError, match="no credential source"):
        resolver({"type": "bearer"}, environment_of(STAFF_PASSWORD="pw"), roles).resolve(
            "api", "staff"
        )


def test_a_role_without_any_credential_source_is_refused() -> None:
    with pytest.raises(CredentialsUnavailableError, match="staff"):
        resolver({"type": "bearer", "token_source": {}}, environment_of()).resolve("api", "staff")


def test_a_missing_environment_value_is_named() -> None:
    with pytest.raises(MissingPlaceholderError, match="STAFF_TOKEN"):
        resolver(
            {"type": "bearer", "token_source": {"staff": "${STAFF_TOKEN}"}}, environment_of()
        ).resolve("api", "staff")


def test_basic_auth_encodes_the_user_and_password_placeholders() -> None:
    access = resolver(
        {"type": "basic", "token_source": {"staff": "${BASIC_USER} and ${BASIC_PASS}"}},
        environment_of(BASIC_USER="bob", BASIC_PASS="pw-2"),
    ).resolve("api", "staff")
    encoded = base64.b64encode(b"bob:pw-2").decode()
    assert access.headers == {"Authorization": f"Basic {encoded}"}
    assert access.derived_secrets == {"STAFF_BASIC_CREDENTIALS": encoded}


def test_basic_auth_needs_exactly_two_placeholders() -> None:
    with pytest.raises(CredentialsUnavailableError, match="user and a password"):
        resolver(
            {"type": "basic", "token_source": {"staff": "${ONLY_ONE}"}},
            environment_of(ONLY_ONE="x"),
        ).resolve("api", "staff")


def test_cookie_auth_logs_in_and_expects_a_session_cookie() -> None:
    access = resolver(
        {
            "type": "cookie",
            "token_source": {
                "staff": "POST /api/auth/login with ${STAFF_EMAIL} and ${STAFF_PASSWORD}"
            },
        },
        environment_of(STAFF_EMAIL="a@b.test", STAFF_PASSWORD="pw-1"),
    ).resolve("api", "staff")
    assert access.session_cookie is True
    assert access.login is not None
    assert access.headers == {}


def test_cookie_auth_without_a_login_request_is_refused() -> None:
    with pytest.raises(CredentialsUnavailableError):
        resolver(
            {"type": "cookie", "token_source": {"staff": "${A_COOKIE}"}},
            environment_of(A_COOKIE="x"),
        ).resolve("api", "staff")


@pytest.mark.parametrize("scheme", ["oauth2", "saml"])
def test_an_unsupported_auth_type_is_refused_by_name(scheme: str) -> None:
    with pytest.raises(CredentialsUnavailableError, match=scheme):
        resolver(
            {"type": scheme, "token_source": {"staff": "${A_TOKEN}"}}, environment_of(A_TOKEN="x")
        ).resolve("api", "staff")


@pytest.mark.parametrize("auth", [None, {"type": "none"}, {"type": "anonymous"}])
def test_an_interface_without_auth_needs_no_credentials(auth: dict[str, Any] | None) -> None:
    access = resolver(auth, environment_of()).resolve("api", "staff")
    assert access.headers == {}
    assert access.login is None


@pytest.mark.parametrize("identity", [None, "anonymous"])
def test_the_anonymous_identity_never_carries_credentials(identity: str | None) -> None:
    access = resolver(
        {"type": "bearer", "token_source": {"staff": "${STAFF_TOKEN}"}},
        environment_of(STAFF_TOKEN="tok-abc"),
    ).resolve("api", identity)
    assert access.role_id is None
    assert access.headers == {}
    assert access.login is None


def test_an_unknown_interface_is_refused() -> None:
    with pytest.raises(InterfaceUnresolvedError, match="nope"):
        resolver({"type": "bearer"}, environment_of()).resolve("nope", "staff")


@pytest.mark.parametrize(
    ("variable", "field"),
    [
        ("STAFF_PASSWORD", "password"),
        ("USER_PASS", "password"),
        ("STAFF_EMAIL", "email"),
        ("ADMIN_USERNAME", "username"),
        ("LOGIN_NAME", "username"),
        ("API_CODE", "api_code"),
    ],
)
def test_login_body_fields_are_guessed_from_the_variable_name(variable: str, field: str) -> None:
    assert credential_field(variable) == field


def test_a_token_is_found_at_the_top_or_under_data() -> None:
    assert extract_token({"access_token": "a"}) == "a"
    assert extract_token({"token": "b"}) == "b"
    assert extract_token({"data": {"accessToken": "c"}}) == "c"
    assert extract_token({"data": {"jwt": "d"}, "other": 1}) == "d"
    assert extract_token({"token": ""}) is None
    assert extract_token({"token": 5}) is None
    assert extract_token([1, 2]) is None
    assert extract_token(None) is None


def test_names_for_runtime_secrets_are_valid_placeholder_names() -> None:
    assert sanitize_name("staff") == "STAFF"
    assert sanitize_name("front-desk.v2") == "FRONT_DESK_V2"
    assert sanitize_name("%%%") == "UNNAMED"


def test_the_interface_address_is_the_linked_url_variable_plus_the_base_path() -> None:
    manifest = minimal_manifest([api_interface(None)])
    environment = ResolvedEnvironment(
        [EnvironmentValue("UNIT_URL", EnvVarKind.url, False, ("api",), "http://host:8080/")]
    )
    resolved = resolve_interface(manifest, "api", environment)
    assert resolved.origin == "http://host:8080"
    assert resolved.base_url == "http://host:8080/api"
    assert resolved.health_url is None


def test_the_health_endpoint_is_joined_to_the_origin_when_it_starts_with_a_slash() -> None:
    interface = api_interface(None) | {"health_endpoint": "/health"}
    manifest = minimal_manifest([interface])
    environment = ResolvedEnvironment(
        [EnvironmentValue("UNIT_URL", EnvVarKind.url, False, ("api",), "http://host:8080")]
    )
    assert resolve_interface(manifest, "api", environment).health_url == "http://host:8080/health"


def test_a_relative_health_endpoint_is_joined_below_the_base() -> None:
    interface = api_interface(None) | {"health_endpoint": "ping"}
    manifest = minimal_manifest([interface])
    environment = ResolvedEnvironment(
        [EnvironmentValue("UNIT_URL", EnvVarKind.url, False, ("api",), "http://host:8080")]
    )
    assert resolve_interface(manifest, "api", environment).health_url == "http://host:8080/api/ping"


def test_an_absolute_base_path_needs_no_url_variable() -> None:
    interface = {"id": "api", "kind": "http", "base_path": "https://other.test/v2/"}
    resolved = resolve_interface(minimal_manifest([interface]), "api", environment_of())
    assert resolved.base_url == "https://other.test/v2"
    assert resolved.origin == "https://other.test"


def test_a_base_path_may_hold_a_placeholder() -> None:
    interface = {"id": "api", "kind": "http", "base_path": "${API_ROOT}"}
    environment = environment_of(API_ROOT="https://placeholder.test/x")
    assert resolve_interface(minimal_manifest([interface]), "api", environment).origin == (
        "https://placeholder.test"
    )


def test_an_interface_without_a_url_variable_value_cannot_be_resolved() -> None:
    with pytest.raises(InterfaceUnresolvedError, match="URL variable"):
        resolve_interface(minimal_manifest([api_interface(None)]), "api", environment_of())


def test_an_unknown_interface_cannot_be_resolved() -> None:
    with pytest.raises(InterfaceUnresolvedError, match="ghost"):
        resolve_interface(minimal_manifest(), "ghost", environment_of())


async def test_the_environment_is_loaded_from_the_real_vault_and_database(
    registered: RegisteredTarget,
) -> None:
    environment = registered.environment
    assert environment.require("STAFF_PASSWORD") == STAFF_PASSWORD
    assert environment.require("MANAGER_TOKEN") == MANAGER_TOKEN
    assert environment.require("ADMIN_TOKEN") == ADMIN_TOKEN
    assert environment.require("STAFF_EMAIL") == STAFF_EMAIL
    assert environment.require("FAKE_TARGET_URL") == registered.running.base_url
    assert set(environment.secrets()) == {"STAFF_PASSWORD", "MANAGER_TOKEN", "ADMIN_TOKEN"}
    assert [value.name for value in environment.urls_for("chat_sse")] == ["FAKE_TARGET_URL"]


async def test_values_cleared_or_never_set_are_not_resolved(
    api_app: FastAPI,
    asgi_client: httpx.AsyncClient,
    registered: RegisteredTarget,
) -> None:
    cleared = await asgi_client.patch(
        f"/api/v1/targets/{registered.target_id}/environment",
        json={"clear": ["ADMIN_TOKEN"]},
        headers=registered.headers,
    )
    assert cleared.status_code == 200
    environment = await registered.reload_environment()
    with pytest.raises(MissingPlaceholderError, match="ADMIN_TOKEN"):
        environment.require("ADMIN_TOKEN")
    assert environment.get("MANAGER_TOKEN") is not None


async def test_stale_variables_are_not_resolved(
    registered: RegisteredTarget,
) -> None:
    async with registered.session_factory() as session:
        await session.execute(
            text(
                "UPDATE environments SET stale = true "
                "WHERE name = 'MANAGER_TOKEN' AND target_id = :id"
            ),
            {"id": registered.target_id},
        )
        await session.commit()
    environment = await registered.reload_environment()
    assert environment.get("MANAGER_TOKEN") is None
    assert environment.get("ADMIN_TOKEN") is not None


async def test_a_target_without_values_has_an_empty_environment(
    registered: RegisteredTarget,
) -> None:
    async with registered.session_factory() as session:
        environment = await load_environment(session, registered.vault, uuid.uuid4())
    assert environment.secrets() == {}
    assert environment.urls_for("api") == []


async def test_roles_resolve_credentials_from_the_stored_manifest_and_vault(
    registered: RegisteredTarget,
) -> None:
    access = AccessResolver(registered.manifest, registered.environment)
    manager = access.resolve("chat_sse", "manager")
    assert manager.headers == {"Authorization": f"Bearer {MANAGER_TOKEN}"}
    admin = access.resolve("api", "admin")
    assert admin.headers == {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    staff = access.resolve("chat_sse", "staff")
    assert staff.login is not None
    assert staff.login.path == "/api/auth/login"
    assert staff.login.body == {"email": STAFF_EMAIL, "password": STAFF_PASSWORD}
    interface = resolve_interface(registered.manifest, "chat_sse", registered.environment)
    assert interface.base_url == registered.running.base_url + "/api/chat"
    assert interface.health_url == registered.running.base_url + "/health"
