import asyncio
import json
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import Cookie, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

from tests.fake_target.chat import ChatReply, answer_tokens, reply_to
from tests.fake_target.database import DatabaseMirror
from tests.fake_target.dataset import (
    SESSION_COOKIE,
    STAFF_EMAIL,
    STAFF_PASSWORD,
    STATIC_TOKENS,
    USERS,
    Dataset,
    seeded_dataset,
)
from tests.fake_target.pages import CHAT_PAGE, LOGIN_PAGE

TOKEN_DELAY_SECONDS = 0.005
MAX_RECORDED_REQUESTS = 500
HANG_SECONDS = 3600
DIRTY_FILTER_DEFECT = "dirty_filter_ignored"
KNOWN_DEFECTS = frozenset({DIRTY_FILTER_DEFECT})
UNMIRRORED_PATHS = frozenset({"/health"})
AuthHeader = Annotated[str | None, Header()]
SessionCookie = Annotated[str | None, Cookie(alias=SESSION_COOKIE)]


class LoginBody(BaseModel):
    email: str
    password: str


class ChatBody(BaseModel):
    message: str = Field(min_length=1)


class IssueBody(BaseModel):
    room: str
    description: str = Field(min_length=1)


class DefectBody(BaseModel):
    enabled: bool


@dataclass(frozen=True)
class RecordedRequest:
    method: str
    path: str
    headers: dict[str, str]


@dataclass
class FakeTargetState:
    dataset: Dataset = field(default_factory=seeded_dataset)
    sessions: dict[str, str] = field(default_factory=dict)
    requests: list[RecordedRequest] = field(default_factory=list)
    defects: set[str] = field(default_factory=set)

    def role_of(self, authorization: str | None, cookie: str | None) -> str | None:
        token = cookie
        if authorization is not None and authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        if token is None:
            return None
        return STATIC_TOKENS.get(token) or self.sessions.get(token)


def sse_frame(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


async def chat_stream(reply: ChatReply, token_delay: float) -> AsyncIterator[bytes]:
    for tool in reply.tools:
        yield sse_frame("tool_call", tool)
    for token in answer_tokens(reply.answer):
        yield sse_frame("token", {"text": token})
        await asyncio.sleep(token_delay)
    for card in reply.cards:
        yield sse_frame("card", card)
    yield sse_frame("done", {"cost_usd": 0.0})


async def hanging_stream() -> AsyncIterator[bytes]:
    yield sse_frame("token", {"text": "partial "})
    await asyncio.sleep(HANG_SECONDS)


def event_stream(content: AsyncIterator[bytes]) -> StreamingResponse:
    return StreamingResponse(
        content,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def deny(status: int, reason: str) -> HTTPException:
    return HTTPException(status_code=status, detail=reason)


def create_app(
    token_delay: float = TOKEN_DELAY_SECONDS, database: DatabaseMirror | None = None
) -> FastAPI:
    app = FastAPI(title="Fake target", docs_url=None, redoc_url=None, openapi_url=None)
    state = FakeTargetState()
    app.state.fake = state

    @app.middleware("http")
    async def record_request(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if len(state.requests) < MAX_RECORDED_REQUESTS:
            headers = {name.lower(): value for name, value in request.headers.items()}
            state.requests.append(RecordedRequest(request.method, request.url.path, headers))
        if database is not None and request.url.path not in UNMIRRORED_PATHS:
            state.dataset = await database.load()
        return await call_next(request)

    def identity(authorization: str | None, cookie: str | None) -> str:
        role = state.role_of(authorization, cookie)
        if role is None:
            raise deny(401, "unauthenticated")
        return role

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/auth/login")
    async def login(body: LoginBody, response: Response) -> dict[str, str]:
        if body.email != STAFF_EMAIL or body.password != STAFF_PASSWORD:
            raise deny(401, "invalid credentials")
        token = "fake-session-" + secrets.token_hex(16)
        state.sessions[token] = "staff"
        response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", path="/")
        return {"access_token": token, "token_type": "bearer", "role": "staff"}

    @app.get("/login", response_class=HTMLResponse)
    async def login_page() -> str:
        return LOGIN_PAGE

    @app.get("/chat", response_model=None)
    async def chat_page(session: SessionCookie = None) -> Response:
        if state.role_of(None, session) is None:
            return RedirectResponse("/login", status_code=302)
        return HTMLResponse(CHAT_PAGE)

    @app.get("/api/me")
    async def me(authorization: AuthHeader = None, session: SessionCookie = None) -> dict[str, str]:
        return {"role": identity(authorization, session)}

    @app.get("/api/rooms")
    async def rooms(
        status: str | None = None, authorization: AuthHeader = None, session: SessionCookie = None
    ) -> dict[str, Any]:
        identity(authorization, session)
        filtered = None if DIRTY_FILTER_DEFECT in state.defects else status
        items = [
            {"number": room.number, "status": room.status, "floor": room.floor}
            for room in state.dataset.rooms_with(filtered)
        ]
        return {"items": items, "total": len(items)}

    @app.get("/api/admin/users")
    async def users(
        authorization: AuthHeader = None, session: SessionCookie = None
    ) -> dict[str, Any]:
        if identity(authorization, session) != "admin":
            raise deny(403, "admin only")
        return {"items": list(USERS), "total": len(USERS)}

    @app.get("/api/issues")
    async def issues(
        status: str | None = None, authorization: AuthHeader = None, session: SessionCookie = None
    ) -> dict[str, Any]:
        identity(authorization, session)
        items = [
            {"room": issue.room, "description": issue.description, "status": issue.status}
            for issue in state.dataset.issues_with(status)
        ]
        return {"items": items, "total": len(items)}

    @app.post("/api/issues", status_code=201)
    async def create_issue(
        body: IssueBody, authorization: AuthHeader = None, session: SessionCookie = None
    ) -> dict[str, str]:
        if identity(authorization, session) == "admin":
            raise deny(403, "admins do not file issues")
        if not state.dataset.has_room(body.room):
            raise deny(422, "unknown room")
        if database is None:
            issue = state.dataset.add_issue(body.room, body.description)
        else:
            issue = await database.insert_issue(body.room, body.description)
        return {"room": issue.room, "description": issue.description, "status": issue.status}

    @app.post("/api/chat/message")
    async def chat_message(
        body: ChatBody, authorization: AuthHeader = None, session: SessionCookie = None
    ) -> StreamingResponse:
        identity(authorization, session)
        return event_stream(chat_stream(reply_to(body.message, state.dataset), token_delay))

    @app.post("/qa/reset")
    async def reset() -> dict[str, str]:
        if database is None:
            state.dataset.reset()
        else:
            await database.reset()
            state.dataset = await database.load()
        return {"hash": state.dataset.state_hash()}

    @app.get("/qa/defects")
    async def defects() -> dict[str, list[str]]:
        return {"enabled": sorted(state.defects), "known": sorted(KNOWN_DEFECTS)}

    @app.put("/qa/defects/{name}")
    async def set_defect(name: str, body: DefectBody) -> dict[str, list[str]]:
        if name not in KNOWN_DEFECTS:
            raise deny(404, "unknown defect")
        if body.enabled:
            state.defects.add(name)
        else:
            state.defects.discard(name)
        return {"enabled": sorted(state.defects), "known": sorted(KNOWN_DEFECTS)}

    @app.get("/qa/hash")
    async def state_hash() -> dict[str, str]:
        return {"hash": state.dataset.state_hash()}

    @app.api_route("/qa/echo", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def echo(request: Request) -> dict[str, Any]:
        raw = await request.body()
        return {
            "method": request.method,
            "authorization": request.headers.get("authorization"),
            "cookie": request.headers.get("cookie"),
            "query": dict(request.query_params),
            "body": raw.decode("utf-8", errors="replace"),
        }

    @app.get("/qa/slow")
    async def slow(ms: int = 100) -> dict[str, int]:
        await asyncio.sleep(ms / 1000)
        return {"slept_ms": ms}

    @app.get("/qa/hang")
    async def hang() -> StreamingResponse:
        return event_stream(hanging_stream())

    @app.get("/qa/sse-echo")
    async def sse_echo(request: Request, split: bool = False) -> StreamingResponse:
        header = request.headers.get("authorization") or ""
        middle = len(header) // 2
        parts = [header[:middle], header[middle:]] if split else [header]

        async def frames() -> AsyncIterator[bytes]:
            for part in parts:
                yield sse_frame("token", {"text": part})
            if not split:
                yield sse_frame("tool_call", {"name": "echo", "args": {"authorization": header}})
                yield sse_frame("card", {"kind": "echo", "authorization": header})
            yield sse_frame("done", {})

        return event_stream(frames())

    @app.get("/qa/sse-flood")
    async def sse_flood(kb: int = 64) -> StreamingResponse:
        async def frames() -> AsyncIterator[bytes]:
            for index in range(kb * 8):
                yield sse_frame("token", {"text": f"{index:04d}" + "x" * 100})
            yield sse_frame("done", {})

        return event_stream(frames())

    @app.get("/qa/big")
    async def big(kb: int = 64) -> dict[str, Any]:
        return {"items": [], "payload": "x" * (kb * 1024)}

    @app.get("/qa/status/{code}")
    async def status_page(code: int) -> JSONResponse:
        return JSONResponse({"code": code}, status_code=code)

    @app.get("/qa/empty")
    async def empty() -> Response:
        return Response(status_code=204)

    @app.get("/qa/text", response_class=Response)
    async def text_page() -> Response:
        return Response("plain text body", media_type="text/plain")

    return app
