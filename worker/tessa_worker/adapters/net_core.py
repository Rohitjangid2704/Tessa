import asyncio
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace

import httpx
from pydantic import JsonValue

from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.health import HealthState
from tessa_worker.adapters.base import TargetTrace
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.errors import AdapterError
from tessa_worker.adapters.http import HttpAdapter
from tessa_worker.adapters.http_core import (
    AuthenticatedIdentity,
    elapsed_ms,
    merge_headers,
    read_limited,
)
from tessa_worker.adapters.step_payloads import PayloadGuard

JSON_CONTENT_TYPE = "application/json"
HTTP_SCHEME_OF = {"ws": "http", "wss": "https"}
COOKIE_HEADER = "Cookie"


@dataclass(frozen=True)
class Received:
    status: int
    headers: dict[str, str]
    raw: bytes
    cut: bool
    latency_ms: int


def http_equivalent(url: str) -> str:
    scheme, separator, rest = url.partition("://")
    mapped = HTTP_SCHEME_OF.get(scheme.lower())
    return f"{mapped}{separator}{rest}" if mapped is not None and separator else url


def http_equivalent_context(context: AdapterContext) -> AdapterContext:
    interface = context.interface
    health_url = None if interface.health_url is None else http_equivalent(interface.health_url)
    return replace(
        context,
        interface=replace(
            interface,
            origin=http_equivalent(interface.origin),
            base_url=http_equivalent(interface.base_url),
            health_url=health_url,
        ),
    )


def compact_json(value: JsonValue) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def cookie_header(cookies: Mapping[str, str]) -> str:
    return "; ".join(f"{name}={value}" for name, value in cookies.items())


def identity_headers(identity: AuthenticatedIdentity) -> dict[str, str]:
    headers = dict(identity.headers)
    if identity.cookies:
        headers[COOKIE_HEADER] = cookie_header(identity.cookies)
    return headers


def request_headers(
    accept: str, has_body: bool, credentials: Mapping[str, str], declared: Mapping[str, str]
) -> dict[str, str]:
    defaults = {"Accept": accept}
    if has_body:
        defaults["Content-Type"] = JSON_CONTENT_TYPE
    return merge_headers(defaults, credentials, declared)


def parse_json_body(raw: bytes, cut: bool) -> JsonValue | None:
    if cut or not raw:
        return None
    try:
        parsed: JsonValue = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    return parsed


def failure_message(error: BaseException, timeout_seconds: float) -> str | None:
    if isinstance(error, AdapterError):
        return str(error)
    if isinstance(error, TimeoutError | httpx.TimeoutException):
        return f"timed out after {timeout_seconds:g}s"
    if isinstance(error, httpx.HTTPError | httpx.InvalidURL):
        return f"{type(error).__name__}: {error}"
    return None


class IdentityBroker:
    def __init__(
        self, context: AdapterContext, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._adapter = HttpAdapter(http_equivalent_context(context), transport)

    async def identity(self, identity: str | None) -> AuthenticatedIdentity:
        return await self._adapter.authenticated_identity(identity)

    async def health(self) -> HealthState:
        return await self._adapter.health()

    async def close(self) -> None:
        await self._adapter.close()


class HttpSender:
    def __init__(
        self, context: AdapterContext, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._timeout = context.limits.step_timeout_seconds
        self._client = httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(self._timeout))

    async def send(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        content: bytes | None,
        budget: int,
    ) -> Received:
        clock = time.perf_counter()
        outgoing = self._client.build_request(method, url, headers=headers, content=content)
        try:
            async with asyncio.timeout(self._timeout):
                response = await self._client.send(outgoing, stream=True)
                try:
                    raw, cut = await read_limited(response, budget)
                finally:
                    await response.aclose()
        finally:
            self._client.cookies.clear()
        return Received(
            status=response.status_code,
            headers=dict(response.headers),
            raw=raw,
            cut=cut,
            latency_ms=elapsed_ms(clock),
        )

    async def close(self) -> None:
        await self._client.aclose()


class NetworkAdapter:
    kind: AdapterKind

    def __init__(
        self, context: AdapterContext, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.context = context
        self.guard = PayloadGuard(context)
        self.identities = IdentityBroker(context, transport)

    @property
    def timeout_seconds(self) -> float:
        return self.context.limits.step_timeout_seconds

    async def trace(self, trace_id: str) -> TargetTrace | None:
        return None

    async def health(self) -> HealthState:
        return await self.identities.health()

    async def close(self) -> None:
        await self.identities.close()
