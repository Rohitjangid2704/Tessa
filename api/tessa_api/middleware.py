import logging
import re
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import update
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from tessa_api.db.models import AgentSessionRow
from tessa_api.db.session import SessionFactory
from tessa_api.errors import error_response, internal_error_response
from tessa_api.ids import new_id
from tessa_api.logging_config import request_id_var
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import AuditAction, AuditSubjectType, AuditVia
from tessa_api.services.audit import record_audit
from tessa_api.services.audit_context import AuditContext, AuthKind, audit_context_var
from tessa_api.settings import Settings

REQUEST_ID_HEADER = "X-Request-ID"
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
BUNDLE_UPLOAD_PATH = "/api/v1/bundles"
BUNDLE_PASTE_PATH = "/api/v1/bundles/paste"
BUNDLE_VALIDATE_PATH = "/api/v1/bundles/validate"
MULTIPART_ENVELOPE_BYTES = 64 * 1024
JSON_ESCAPE_FACTOR = 6
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
UNAUDITED_PATH_PREFIXES = (
    "/api/v1/agent-sessions",
    "/api/v1/ws-tickets",
    "/api/v1/bundles/validate",
    "/api/v1/plans/preview",
    "/api/v1/scenarios/validate",
)
RESPONSE_HEAD_BYTES = 8192
RESOURCE_ID_PATTERN = re.compile(rb'"(?:id|run_id)"\s*:\s*"([0-9a-fA-F-]{36})"')
PATH_PARAMETER_PATTERN = re.compile(r"[{]([^}:]+)(?::[^}]*)?[}]")
AUDIT_ATTEMPTS = 2

logger = logging.getLogger("tessa_api.request")


def resolve_request_id(incoming: str | None) -> str:
    if incoming is not None and REQUEST_ID_PATTERN.fullmatch(incoming):
        return incoming
    return str(new_id())


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        request_id = resolve_request_id(Headers(scope=scope).get(REQUEST_ID_HEADER))
        token = request_id_var.set(request_id)
        scope.setdefault("state", {})["request_id"] = request_id
        started = time.perf_counter()
        status_code = 0

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            if scope["type"] == "http":
                logger.info(
                    "http_request",
                    extra={
                        "method": scope["method"],
                        "path": scope["path"],
                        "status": status_code,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    },
                )
            request_id_var.reset(token)


def upload_body_limits(settings: Settings) -> dict[str, int]:
    return {
        BUNDLE_UPLOAD_PATH: settings.bundle_max_zip_bytes + MULTIPART_ENVELOPE_BYTES,
        BUNDLE_VALIDATE_PATH: settings.bundle_max_zip_bytes + MULTIPART_ENVELOPE_BYTES,
        BUNDLE_PASTE_PATH: settings.bundle_max_manifest_bytes * JSON_ESCAPE_FACTOR
        + MULTIPART_ENVELOPE_BYTES,
    }


def oversized_message(limit: int) -> str:
    return f"The request body is larger than {limit} bytes"


class BodySizeGuardMiddleware:
    def __init__(self, app: ASGIApp, limits: Mapping[str, int]) -> None:
        self.app = app
        self.limits = dict(limits)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        limit = self.limit_for(scope)
        if limit is None:
            await self.app(scope, receive, send)
            return
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            detail = ErrorDetail(
                loc=["header", "content-length"],
                code="body_too_large",
                message=oversized_message(limit),
            )
            response = error_response(413, "payload_too_large", oversized_message(limit), [detail])
            await response(scope, receive, send)
            return
        received = 0

        async def counting_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise HTTPException(status_code=413, detail=oversized_message(limit))
            return message

        await self.app(scope, counting_receive, send)

    def limit_for(self, scope: Scope) -> int | None:
        if scope["type"] != "http" or scope["method"] != "POST":
            return None
        return self.limits.get(scope["path"].rstrip("/"))


class ErrorBoundaryMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        response_started = False

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception:
            logger.exception(
                "unhandled_exception",
                extra={"method": scope["method"], "path": scope["path"]},
            )
            if response_started:
                raise
            await internal_error_response()(scope, receive, send)


@dataclass(slots=True)
class ResponseFacts:
    status: int = 0
    replayed: bool = False
    json: bool = False
    head: bytearray = field(default_factory=bytearray)


def observe_response(facts: ResponseFacts, message: Message) -> None:
    if message["type"] == "http.response.start":
        headers = Headers(raw=message["headers"])
        facts.status = message["status"]
        facts.replayed = "idempotency-replayed" in headers
        facts.json = headers.get("content-type", "").startswith("application/json")
    elif message["type"] == "http.response.body" and facts.json:
        room = RESPONSE_HEAD_BYTES - len(facts.head)
        if room > 0:
            facts.head.extend(message.get("body", b"")[:room])


def route_template(scope: Scope) -> str:
    path = str(scope["path"])
    relative = getattr(scope.get("route"), "path", None)
    if not isinstance(relative, str):
        return path
    params = scope.get("path_params") or {}
    tail = PATH_PARAMETER_PATTERN.sub(
        lambda found: str(params.get(found.group(1), found.group(0))), relative
    )
    if not path.endswith(tail):
        return path
    return path[: len(path) - len(tail)] + relative


def is_unaudited_path(scope: Scope) -> bool:
    return route_template(scope).startswith(UNAUDITED_PATH_PREFIXES)


def should_record(scope: Scope, context: AuditContext, facts: ResponseFacts) -> bool:
    return (
        context.auth_kind is AuthKind.personal
        and context.user_id is not None
        and scope["method"] in WRITE_METHODS
        and 200 <= facts.status < 400
        and not facts.replayed
        and not is_unaudited_path(scope)
    )


def written_resource_id(scope: Scope, facts: ResponseFacts) -> uuid.UUID | None:
    found = RESOURCE_ID_PATTERN.search(bytes(facts.head))
    if found is not None:
        try:
            return uuid.UUID(found.group(1).decode("ascii"))
        except ValueError:
            return None
    for value in reversed(list((scope.get("path_params") or {}).values())):
        try:
            return uuid.UUID(str(value))
        except ValueError:
            continue
    return None


class AuditLedgerMiddleware:
    def __init__(self, app: ASGIApp, session_factory: SessionFactory) -> None:
        self.app = app
        self.session_factory = session_factory

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        context = AuditContext()
        reset_token = audit_context_var.set(context)
        facts = ResponseFacts()

        async def send_and_observe(message: Message) -> None:
            observe_response(facts, message)
            await send(message)

        try:
            await self.app(scope, receive, send_and_observe)
        finally:
            audit_context_var.reset(reset_token)
        if should_record(scope, context, facts):
            await self.record(scope, context, facts)

    async def record(self, scope: Scope, context: AuditContext, facts: ResponseFacts) -> None:
        detail = {
            "method": scope["method"],
            "path": route_template(scope),
            "status": facts.status,
            "request_id": (scope.get("state") or {}).get("request_id"),
        }
        subject_id = written_resource_id(scope, facts)
        for attempt in range(AUDIT_ATTEMPTS):
            try:
                async with self.session_factory() as session:
                    await record_audit(
                        session,
                        context.user_id,
                        AuditAction.personal_token_write,
                        AuditSubjectType.route,
                        subject_id,
                        detail,
                        via=AuditVia.mcp,
                        agent_session_id=context.agent_session_id,
                    )
                    if context.agent_session_id is not None:
                        await session.execute(
                            update(AgentSessionRow)
                            .where(AgentSessionRow.id == context.agent_session_id)
                            .values(write_count=AgentSessionRow.write_count + 1)
                        )
                    await session.commit()
                return
            except Exception:
                if attempt + 1 == AUDIT_ATTEMPTS:
                    logger.exception(
                        "personal_token_write_not_audited",
                        extra={"method": detail["method"], "path": detail["path"]},
                    )
