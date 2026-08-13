import base64
import json
import re
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

import httpx
from pydantic import JsonValue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import EnvironmentRow
from tessa_api.schemas.bundle import (
    HMAC_SHA256_AUTH_TYPE,
    BundleManifest,
    Interface,
    InterfaceAuth,
    Role,
)
from tessa_api.schemas.enums import EnvVarKind
from tessa_api.schemas.scenario import ANONYMOUS_IDENTITY
from tessa_api.services.environment import resolve_values
from tessa_api.services.vault import Vault
from tessa_worker.adapters.errors import (
    CredentialsUnavailableError,
    InterfaceUnresolvedError,
    MissingPlaceholderError,
)
from tessa_worker.adapters.redact import Redactor

PLACEHOLDER_PATTERN = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")
WHOLE_PLACEHOLDER_PATTERN = re.compile(r"^\$\{([A-Z][A-Z0-9_]*)\}$")
LOGIN_PATTERN = re.compile(r"^(GET|POST|PUT|PATCH)\s+(\S+)(?:\s+(.*))?$", re.IGNORECASE | re.DOTALL)
TOKEN_KEYS = ("access_token", "token", "accessToken", "id_token", "jwt")
NO_AUTH_SCHEMES = frozenset({"", "none", "anonymous"})
BEARER_SCHEMES = frozenset({"bearer", "token", "jwt"})
API_KEY_SCHEMES = frozenset({"api_key", "apikey", "header"})
BASIC_SCHEMES = frozenset({"basic"})
COOKIE_SCHEMES = frozenset({"cookie", "session"})
AUTHORIZATION_HEADER = "Authorization"
API_KEY_HEADER = "X-API-Key"
BEARER_PREFIX = "Bearer "


@dataclass(frozen=True)
class EnvironmentValue:
    name: str
    kind: EnvVarKind
    secret: bool
    interface_ids: tuple[str, ...]
    value: str = field(repr=False)


class ResolvedEnvironment:
    def __init__(self, values: Iterable[EnvironmentValue]) -> None:
        self._values = {value.name: value for value in values}

    def get(self, name: str) -> EnvironmentValue | None:
        return self._values.get(name)

    def require(self, name: str) -> str:
        found = self._values.get(name)
        if found is None:
            raise MissingPlaceholderError(name)
        return found.value

    def all_values(self) -> list[EnvironmentValue]:
        return list(self._values.values())

    def secrets(self) -> dict[str, str]:
        return {value.name: value.value for value in self._values.values() if value.secret}

    def urls_for(self, interface_id: str) -> list[EnvironmentValue]:
        return [
            value
            for value in self._values.values()
            if value.kind is EnvVarKind.url and interface_id in value.interface_ids
        ]

    def substitute(self, text: str) -> str:
        return PLACEHOLDER_PATTERN.sub(lambda match: self.require(match.group(1)), text)

    def substitute_json(self, value: JsonValue) -> JsonValue:
        if isinstance(value, str):
            return self.substitute(value)
        if isinstance(value, list):
            return [self.substitute_json(item) for item in value]
        if isinstance(value, dict):
            return {key: self.substitute_json(item) for key, item in value.items()}
        return value

    def new_redactor(self) -> Redactor:
        return Redactor(self.secrets())


async def load_environment(
    session: AsyncSession, vault: Vault, target_id: uuid.UUID
) -> ResolvedEnvironment:
    resolved = await resolve_values(session, vault, target_id)
    if not resolved:
        return ResolvedEnvironment(())
    rows = await session.execute(
        select(
            EnvironmentRow.name,
            EnvironmentRow.kind,
            EnvironmentRow.secret,
            EnvironmentRow.interface_ids,
        ).where(EnvironmentRow.target_id == target_id, EnvironmentRow.name.in_(list(resolved)))
    )
    return ResolvedEnvironment(
        EnvironmentValue(
            name=name,
            kind=kind,
            secret=secret,
            interface_ids=tuple(interface_ids),
            value=resolved[name].get_secret_value(),
        )
        for name, kind, secret, interface_ids in rows
    )


@dataclass(frozen=True)
class LoginSpec:
    method: str
    path: str
    body: JsonValue = field(repr=False, default=None)


@dataclass(frozen=True)
class RoleAccess:
    role_id: str | None
    headers: Mapping[str, str] = field(repr=False, default_factory=dict)
    login: LoginSpec | None = None
    token_header: str | None = None
    token_prefix: str = ""
    derived_secrets: Mapping[str, str] = field(repr=False, default_factory=dict)
    session_cookie: bool = False


def sanitize_name(text: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_").upper()
    return cleaned or "UNNAMED"


def credential_field(variable_name: str) -> str:
    upper = variable_name.upper()
    if "PASS" in upper:
        return "password"
    if "EMAIL" in upper:
        return "email"
    if "USER" in upper or "LOGIN" in upper:
        return "username"
    return variable_name.lower()


def extract_token(payload: JsonValue) -> str | None:
    containers = [payload]
    if isinstance(payload, dict):
        containers.append(payload.get("data"))
    for container in containers:
        if not isinstance(container, dict):
            continue
        for key in TOKEN_KEYS:
            candidate = container.get(key)
            if isinstance(candidate, str) and candidate:
                return candidate
    return None


def token_from_login_response(response: httpx.Response) -> str | None:
    try:
        payload: JsonValue = response.json()
    except ValueError:
        return None
    return extract_token(payload)


class AccessResolver:
    def __init__(self, manifest: BundleManifest, environment: ResolvedEnvironment) -> None:
        self._interfaces = {interface.id: interface for interface in manifest.interfaces}
        self._roles = {role.id: role for role in manifest.roles}
        self._environment = environment

    def resolve(self, interface_id: str, role_id: str | None) -> RoleAccess:
        if role_id is None or role_id == ANONYMOUS_IDENTITY:
            return RoleAccess(role_id=None)
        interface = self._interface(interface_id)
        auth = interface.auth
        scheme = auth.type.strip().lower() if auth is not None else ""
        if auth is None or scheme in NO_AUTH_SCHEMES or scheme == HMAC_SHA256_AUTH_TYPE:
            return RoleAccess(role_id=role_id)
        source = self._token_source(interface, auth, role_id)
        if scheme in BEARER_SCHEMES:
            return self._token_access(
                role_id, source, auth.header or AUTHORIZATION_HEADER, BEARER_PREFIX
            )
        if scheme in API_KEY_SCHEMES:
            return self._token_access(role_id, source, auth.header or API_KEY_HEADER, "")
        if scheme in BASIC_SCHEMES:
            return self._basic_access(role_id, source, auth.header or AUTHORIZATION_HEADER)
        if scheme in COOKIE_SCHEMES:
            return self._cookie_access(role_id, source)
        raise CredentialsUnavailableError(
            f"interface {interface_id} uses auth type {auth.type}, which is not supported"
        )

    def _interface(self, interface_id: str) -> Interface:
        interface = self._interfaces.get(interface_id)
        if interface is None:
            raise InterfaceUnresolvedError(f"the bundle declares no interface {interface_id}")
        return interface

    def _token_source(self, interface: Interface, auth: InterfaceAuth, role_id: str) -> str:
        declared = auth.token_source.get(role_id)
        if declared is not None and declared.strip():
            return declared.strip()
        role: Role | None = self._roles.get(role_id)
        credential = role.credential_env if role is not None else None
        variable = self._environment.get(credential) if credential is not None else None
        if credential is not None and variable is not None and variable.kind is EnvVarKind.token:
            return "${" + credential + "}"
        raise CredentialsUnavailableError(
            f"interface {interface.id} declares no credential source for role {role_id}"
        )

    def _token_access(self, role_id: str, source: str, header: str, prefix: str) -> RoleAccess:
        whole = WHOLE_PLACEHOLDER_PATTERN.match(source)
        if whole is not None:
            token = self._environment.require(whole.group(1))
            return RoleAccess(role_id=role_id, headers={header: prefix + token})
        login = self._login_spec(source)
        return RoleAccess(role_id=role_id, login=login, token_header=header, token_prefix=prefix)

    def _basic_access(self, role_id: str, source: str, header: str) -> RoleAccess:
        names = PLACEHOLDER_PATTERN.findall(source)
        if len(names) != 2:
            raise CredentialsUnavailableError(
                f"basic auth for role {role_id} needs a user and a password placeholder"
            )
        user, password = (self._environment.require(name) for name in names)
        encoded = base64.b64encode(f"{user}:{password}".encode()).decode()
        return RoleAccess(
            role_id=role_id,
            headers={header: f"Basic {encoded}"},
            derived_secrets={f"{sanitize_name(role_id)}_BASIC_CREDENTIALS": encoded},
        )

    def _cookie_access(self, role_id: str, source: str) -> RoleAccess:
        return RoleAccess(role_id=role_id, login=self._login_spec(source), session_cookie=True)

    def _login_spec(self, source: str) -> LoginSpec:
        matched = LOGIN_PATTERN.match(source)
        if matched is None:
            raise CredentialsUnavailableError(
                "the token source is neither a ${NAME} placeholder nor a login request such as "
                "POST /auth/login with ${EMAIL} and ${PASSWORD}"
            )
        method, path, remainder = matched.group(1).upper(), matched.group(2), matched.group(3)
        return LoginSpec(method=method, path=path, body=self._login_body(remainder or ""))

    def _login_body(self, remainder: str) -> JsonValue:
        text = remainder.strip()
        if text.startswith("{"):
            try:
                template: JsonValue = json.loads(text)
            except ValueError:
                raise CredentialsUnavailableError("the login body is not valid JSON") from None
            return self._environment.substitute_json(template)
        names = PLACEHOLDER_PATTERN.findall(text)
        if not names:
            return None
        return {credential_field(name): self._environment.require(name) for name in names}
