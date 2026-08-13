import asyncio
import logging
import time
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime

import httpx
from pydantic import JsonValue

from tessa_api.schemas.enums import AdapterKind, HealthCheckStatus
from tessa_api.schemas.health import HealthState
from tessa_api.schemas.scenario import ANONYMOUS_IDENTITY, QueryValue, RequestSpec
from tessa_api.schemas.steps import (
    HttpStepRequest,
    SseStepRequest,
    StepRequestUnion,
    StepResponseUnion,
    StepTool,
)
from tessa_worker.adapters.auth import (
    LoginSpec,
    RoleAccess,
    sanitize_name,
    token_from_login_response,
)
from tessa_worker.adapters.base import StepRecord, TargetTrace
from tessa_worker.adapters.context import ABSOLUTE_URL_PREFIXES, AdapterContext
from tessa_worker.adapters.errors import AdapterError, LoginError
from tessa_worker.adapters.payload import fit_json, fit_text

JSON_CONTENT_TYPE = "application/json"
CLIENT_LOGGERS = ("httpx", "httpcore")
QueryPair = tuple[str, str | int | float | bool | None]


@dataclass(frozen=True)
class OutgoingRequest:
    method: str
    url: str
    headers: dict[str, str]
    query: dict[str, JsonValue]
    body: JsonValue


@dataclass
class Exchange:
    ok: bool
    response: StepResponseUnion | None = None
    error: str | None = None
    truncated: bool = False
    latency_ms: int | None = None
    answer: str | None = None
    tools: list[StepTool] = field(default_factory=list)
    cards: list[dict[str, JsonValue]] = field(default_factory=list)
    cost_usd: float = 0.0


@dataclass
class IdentitySession:
    client: httpx.AsyncClient
    access: RoleAccess
    auth_headers: dict[str, str]
    authenticated: bool = False
    failure: str | None = None


@dataclass(frozen=True)
class AuthenticatedIdentity:
    headers: Mapping[str, str] = field(repr=False)
    cookies: Mapping[str, str] = field(repr=False)


def keep_secrets_out_of_client_logs() -> None:
    for name in CLIENT_LOGGERS:
        logger = logging.getLogger(name)
        if logger.getEffectiveLevel() < logging.WARNING:
            logger.setLevel(logging.WARNING)


def merge_headers(*layers: Mapping[str, str]) -> dict[str, str]:
    merged: dict[str, str] = {}
    spelling: dict[str, str] = {}
    for layer in layers:
        for name, value in layer.items():
            lowered = name.lower()
            if lowered in spelling:
                del merged[spelling[lowered]]
            spelling[lowered] = name
            merged[name] = value
    return merged


def query_value(value: QueryValue) -> JsonValue:
    if isinstance(value, list):
        items: list[JsonValue] = list(value)
        return items
    return value


def query_pairs(query: Mapping[str, JsonValue]) -> list[QueryPair]:
    pairs: list[QueryPair] = []
    for name, value in query.items():
        values = value if isinstance(value, list) else [value]
        pairs.extend((name, query_text(item)) for item in values)
    return pairs


def query_text(value: JsonValue) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def elapsed_ms(clock: float) -> int:
    return round((time.perf_counter() - clock) * 1000)


async def read_limited(response: httpx.Response, limit: int) -> tuple[bytes, bool]:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        remaining = limit - size
        if len(chunk) > remaining:
            chunks.append(chunk[:remaining])
            return b"".join(chunks), True
        chunks.append(chunk)
        size += len(chunk)
    return b"".join(chunks), False


class HttpFamilyAdapter(ABC):
    kind: AdapterKind
    default_accept: str

    def __init__(
        self, context: AdapterContext, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        keep_secrets_out_of_client_logs()
        self.context = context
        self._transport = transport
        self._sessions: dict[str | None, IdentitySession] = {}

    async def drive_request(
        self, request: RequestSpec, label: str | None, ask: str | None, identity: str | None
    ) -> StepRecord:
        started_at = datetime.now(UTC)
        clock = time.perf_counter()
        sent = self._with_headers(self._plain_request(request), {})
        try:
            resolved = self._resolved_request(request)
            session = self._session(identity)
            await self._authenticate(session)
            sent = self._with_headers(resolved, session.auth_headers)
            exchange = await self.exchange(session, sent, clock)
        except AdapterError as error:
            exchange = Exchange(ok=False, error=str(error))
        except (TimeoutError, httpx.TimeoutException):
            seconds = self.context.limits.step_timeout_seconds
            exchange = Exchange(ok=False, error=f"timed out after {seconds:g}s")
        except (httpx.HTTPError, httpx.InvalidURL) as error:
            exchange = Exchange(ok=False, error=f"{type(error).__name__}: {error}")
        latency_ms = exchange.latency_ms if exchange.latency_ms is not None else elapsed_ms(clock)
        return self._record(request, label, ask, sent, exchange, latency_ms, started_at)

    async def authenticated_identity(self, identity: str | None) -> AuthenticatedIdentity:
        session = self._session(identity)
        await self._authenticate(session)
        cookies = {
            cookie.name: cookie.value for cookie in session.client.cookies.jar if cookie.value
        }
        return AuthenticatedIdentity(headers=dict(session.auth_headers), cookies=cookies)

    @abstractmethod
    async def exchange(
        self, session: IdentitySession, request: OutgoingRequest, clock: float
    ) -> Exchange: ...

    async def trace(self, trace_id: str) -> TargetTrace | None:
        return None

    async def health(self) -> HealthState:
        url = self.context.interface.health_url
        checked_at = datetime.now(UTC)
        if url is None:
            return HealthState(
                status=HealthCheckStatus.skipped,
                checked_at=checked_at,
                latency_ms=None,
                message="the interface declares no health endpoint",
            )
        clock = time.perf_counter()
        timeout = self.context.limits.step_timeout_seconds
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
                response = await client.get(url)
        except (httpx.HTTPError, httpx.InvalidURL) as error:
            message = self.context.redactor.redact_text(f"{type(error).__name__}: {error}")
            return HealthState(
                status=HealthCheckStatus.failed,
                checked_at=checked_at,
                latency_ms=elapsed_ms(clock),
                message=message,
            )
        healthy = response.is_success
        return HealthState(
            status=HealthCheckStatus.ok if healthy else HealthCheckStatus.failed,
            checked_at=checked_at,
            latency_ms=elapsed_ms(clock),
            message=None if healthy else f"HTTP {response.status_code}",
        )

    async def close(self) -> None:
        sessions = list(self._sessions.values())
        self._sessions.clear()
        await asyncio.gather(*(session.client.aclose() for session in sessions))

    def read_budget(self, factor: int = 1) -> int:
        limits = self.context.limits
        return limits.max_payload_bytes * factor + self.context.redactor.max_secret_length + 1

    def note_cookies(self, session: IdentitySession) -> None:
        for cookie in session.client.cookies.jar:
            if cookie.value:
                name = f"SESSION_COOKIE_{sanitize_name(cookie.name)}"
                self.context.redactor.register(name, cookie.value)

    def build_request(self, session: IdentitySession, request: OutgoingRequest) -> httpx.Request:
        url = httpx.URL(request.url)
        pairs = query_pairs(request.query)
        if pairs:
            url = url.copy_merge_params(pairs)
        return session.client.build_request(
            request.method, url, headers=request.headers, json=request.body
        )

    def _with_headers(
        self, request: OutgoingRequest, credentials: Mapping[str, str]
    ) -> OutgoingRequest:
        defaults = {"Accept": self.default_accept}
        if request.body is not None:
            defaults["Content-Type"] = JSON_CONTENT_TYPE
        return replace(request, headers=merge_headers(defaults, credentials, request.headers))

    def _plain_request(self, request: RequestSpec) -> OutgoingRequest:
        return OutgoingRequest(
            method=request.method,
            url=self.context.interface.base_url + request.path,
            headers=dict(request.headers),
            query={name: query_value(value) for name, value in request.query.items()},
            body=request.body,
        )

    def _resolved_request(self, request: RequestSpec) -> OutgoingRequest:
        environment = self.context.environment
        plain = self._plain_request(request)
        return OutgoingRequest(
            method=plain.method,
            url=environment.substitute(plain.url),
            headers={name: environment.substitute(value) for name, value in plain.headers.items()},
            query={name: environment.substitute_json(value) for name, value in plain.query.items()},
            body=environment.substitute_json(plain.body),
        )

    def _session(self, identity: str | None) -> IdentitySession:
        role: str | None = self.context.role if identity is None else identity
        if role == ANONYMOUS_IDENTITY:
            role = None
        existing = self._sessions.get(role)
        if existing is not None:
            return existing
        access = self.context.access.resolve(self.context.interface.id, role)
        for name, value in access.derived_secrets.items():
            self.context.redactor.register(name, value)
        client = httpx.AsyncClient(
            transport=self._transport,
            timeout=httpx.Timeout(self.context.limits.step_timeout_seconds),
        )
        created = IdentitySession(client=client, access=access, auth_headers=dict(access.headers))
        self._sessions[role] = created
        return created

    async def _authenticate(self, session: IdentitySession) -> None:
        if session.authenticated:
            return
        if session.failure is not None:
            raise LoginError(session.failure)
        login = session.access.login
        if login is not None:
            try:
                await self._login(session, login)
            except LoginError as error:
                session.failure = str(error)
                raise
            except (TimeoutError, httpx.HTTPError, httpx.InvalidURL) as error:
                session.failure = f"login request failed: {type(error).__name__}"
                raise LoginError(session.failure) from None
        session.authenticated = True

    async def _login(self, session: IdentitySession, login: LoginSpec) -> None:
        url = login.path
        if not url.lower().startswith(ABSOLUTE_URL_PREFIXES):
            url = self.context.interface.origin + url
        async with asyncio.timeout(self.context.limits.step_timeout_seconds):
            response = await session.client.request(
                login.method,
                url,
                json=login.body,
                headers={"Accept": JSON_CONTENT_TYPE},
            )
        if not response.is_success:
            raise LoginError(f"login answered HTTP {response.status_code}")
        token = token_from_login_response(response)
        if token is not None and session.access.token_header is not None:
            header = session.access.token_header
            session.auth_headers[header] = session.access.token_prefix + token
            role_name = sanitize_name(session.access.role_id or "")
            self.context.redactor.register(f"{role_name}_SESSION_TOKEN", token)
        self.note_cookies(session)
        if token is None and not session.client.cookies:
            raise LoginError("login returned no token and set no cookie")

    def _record(
        self,
        request: RequestSpec,
        label: str | None,
        ask: str | None,
        sent: OutgoingRequest,
        exchange: Exchange,
        latency_ms: int,
        started_at: datetime,
    ) -> StepRecord:
        redactor = self.context.redactor
        cap = self.context.limits.max_payload_bytes
        described, request_truncated = self._describe_request(sent)
        recorded_ask = None
        if ask is not None:
            recorded_ask = fit_text(redactor.redact_text(ask), cap)[0]
        error = redactor.redact_text(exchange.error) if exchange.error is not None else None
        return StepRecord(
            adapter=self.kind,
            label=redactor.redact_text(label or f"{request.method} {request.path}"),
            request=described,
            response=exchange.response,
            response_truncated=exchange.truncated or request_truncated,
            ok=exchange.ok,
            error=error,
            ask=recorded_ask,
            answer=exchange.answer,
            tools=exchange.tools,
            cards=exchange.cards,
            latency_ms=latency_ms,
            cost_usd=exchange.cost_usd,
            started_at=started_at,
            finished_at=datetime.now(UTC),
        )

    def _describe_request(self, sent: OutgoingRequest) -> tuple[StepRequestUnion, bool]:
        redactor = self.context.redactor
        fitted = fit_json(redactor.redact_json(sent.body), self.context.limits.max_payload_bytes)
        body: JsonValue = fitted.text if fitted.truncated else fitted.value
        url = redactor.redact_text(sent.url)
        headers = redactor.redact_mapping(sent.headers)
        redacted_query = redactor.redact_json(sent.query)
        query: dict[str, JsonValue] | None = (
            redacted_query if isinstance(redacted_query, dict) and redacted_query else None
        )
        if self.kind is AdapterKind.sse:
            sse_request = SseStepRequest(
                kind="sse", method=sent.method, url=url, headers=headers, query=query, body=body
            )
            return sse_request, fitted.truncated
        http_request = HttpStepRequest(
            kind="http", method=sent.method, url=url, headers=headers, query=query, body=body
        )
        return http_request, fitted.truncated
