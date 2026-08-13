import asyncio
import json
from dataclasses import dataclass

import httpx
from pydantic import JsonValue

from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.scenario import HttpStep, ScenarioStep
from tessa_api.schemas.steps import HttpStepResponse
from tessa_worker.adapters.base import Adapter, StepRecord
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.http_core import (
    Exchange,
    HttpFamilyAdapter,
    IdentitySession,
    OutgoingRequest,
    elapsed_ms,
    read_limited,
)
from tessa_worker.adapters.payload import fit_json, fit_text

BINARY_CONTENT_PREFIXES = ("image/", "audio/", "video/", "font/")
BINARY_CONTENT_TYPES = frozenset(
    {"application/octet-stream", "application/zip", "application/pdf", "application/gzip"}
)


@dataclass(frozen=True)
class ParsedJson:
    value: JsonValue


def media_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def is_json_type(content_type: str) -> bool:
    kind = media_type(content_type)
    return kind == "application/json" or kind.endswith("+json")


def is_binary_type(content_type: str) -> bool:
    kind = media_type(content_type)
    return kind.startswith(BINARY_CONTENT_PREFIXES) or kind in BINARY_CONTENT_TYPES


def decode_body(raw: bytes, charset: str | None) -> str:
    return raw.decode(charset or "utf-8", errors="replace")


class HttpAdapter(HttpFamilyAdapter):
    kind = AdapterKind.http
    default_accept = "application/json"

    async def drive(self, step: ScenarioStep) -> StepRecord:
        if not isinstance(step, HttpStep):
            raise TypeError(f"the http adapter cannot drive a {step.adapter} step")
        return await self.drive_request(step.request, step.label, None, step.as_)

    async def exchange(
        self, session: IdentitySession, request: OutgoingRequest, clock: float
    ) -> Exchange:
        outgoing = self.build_request(session, request)
        async with asyncio.timeout(self.context.limits.step_timeout_seconds):
            response = await session.client.send(outgoing, stream=True)
            try:
                self.note_cookies(session)
                raw, cut = await read_limited(response, self.read_budget())
            finally:
                await response.aclose()
        latency_ms = elapsed_ms(clock)
        described, truncated = self.describe_response(response, raw, cut)
        return Exchange(ok=True, response=described, truncated=truncated, latency_ms=latency_ms)

    def describe_response(
        self, response: httpx.Response, raw: bytes, cut: bool
    ) -> tuple[HttpStepResponse, bool]:
        redactor = self.context.redactor
        cap = self.context.limits.max_payload_bytes
        content_type = response.headers.get("content-type", "")
        headers = redactor.redact_mapping(dict(response.headers))
        parsed = None if cut or not is_json_type(content_type) else self.parse_json(raw, response)
        if parsed is not None:
            fitted = fit_json(redactor.redact_json(parsed.value), cap)
            return (
                HttpStepResponse(
                    kind="http",
                    status=response.status_code,
                    headers=headers,
                    body=fitted.value,
                    body_text=fitted.text,
                ),
                fitted.truncated,
            )
        text = self.body_text(raw, cut, response, content_type)
        fitted_text = fit_text(text, cap) if text is not None else (None, False)
        return (
            HttpStepResponse(
                kind="http",
                status=response.status_code,
                headers=headers,
                body=None,
                body_text=fitted_text[0],
            ),
            cut or fitted_text[1],
        )

    def parse_json(self, raw: bytes, response: httpx.Response) -> ParsedJson | None:
        try:
            value: JsonValue = json.loads(decode_body(raw, response.charset_encoding))
        except ValueError:
            return None
        return ParsedJson(value)

    def body_text(
        self, raw: bytes, cut: bool, response: httpx.Response, content_type: str
    ) -> str | None:
        if not raw:
            return None
        if is_binary_type(content_type):
            qualifier = "at least " if cut else ""
            return f"<binary body of {qualifier}{len(raw)} bytes, {media_type(content_type)}>"
        text = decode_body(raw, response.charset_encoding)
        redactor = self.context.redactor
        return redactor.redact_prefix(text) if cut else redactor.redact_text(text)


async def open_http_adapter(context: AdapterContext) -> Adapter:
    return HttpAdapter(context)
