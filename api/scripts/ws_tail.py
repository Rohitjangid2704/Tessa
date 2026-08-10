import argparse
import asyncio
import json
import sys
import uuid

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from tessa_api.auth.jwt import DEFAULT_TTL_SECONDS, encode_api_token
from tessa_api.auth.users import get_user_by_email
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.settings import Settings, load_settings

TERMINAL_EVENT_TYPE = "run.finished"


async def mint_token(settings: Settings, email: str | None) -> str | None:
    login = email or settings.bootstrap_admin_email
    if not login:
        sys.stderr.write("pass --email or --token, or set TESSA_BOOTSTRAP_ADMIN_EMAIL\n")
        return None
    engine = create_engine(settings.database_url)
    try:
        async with create_session_factory(engine)() as session:
            user = await get_user_by_email(session, login)
    finally:
        await engine.dispose()
    if user is None:
        sys.stderr.write(f"no user with email {login}\n")
        return None
    return encode_api_token(settings, user.id, user.email, user.role, DEFAULT_TTL_SECONDS)


async def request_ticket_url(api_url: str, token: str, run_id: uuid.UUID) -> str | None:
    async with httpx.AsyncClient(base_url=api_url, timeout=10) as client:
        response = await client.post(
            "/api/v1/ws-tickets",
            json={"run_id": str(run_id)},
            headers={"Authorization": f"Bearer {token}"},
        )
    if response.status_code != 200:
        sys.stderr.write(f"ticket request failed: {response.status_code} {response.text}\n")
        return None
    ws_url: str = response.json()["ws_url"]
    return ws_url


async def tail(ws_url: str, last_seq: int, follow: bool) -> int:
    try:
        async with connect(f"{ws_url}&last_seq={last_seq}") as connection:
            async for message in connection:
                text = message if isinstance(message, str) else message.decode("utf-8")
                sys.stdout.write(text + "\n")
                sys.stdout.flush()
                if not follow and json.loads(text).get("type") == TERMINAL_EVENT_TYPE:
                    return 0
    except ConnectionClosed as closed:
        code = closed.rcvd.code if closed.rcvd is not None else 1006
        sys.stderr.write(f"connection closed with code {code}\n")
        return 0 if code == 1000 else 1
    except InvalidStatus as rejected:
        sys.stderr.write(f"handshake rejected with HTTP {rejected.response.status_code}\n")
        return 1
    return 0


async def run(
    run_id: uuid.UUID,
    email: str | None,
    token: str | None,
    api_url: str | None,
    last_seq: int,
    follow: bool,
    timeout_seconds: float,
) -> int:
    settings = load_settings()
    bearer = token or await mint_token(settings, email)
    if bearer is None:
        return 2
    ws_url = await request_ticket_url(api_url or settings.public_api_url, bearer, run_id)
    if ws_url is None:
        return 1
    try:
        async with asyncio.timeout(timeout_seconds):
            return await tail(ws_url, last_seq, follow)
    except TimeoutError:
        sys.stderr.write(f"stopped after {timeout_seconds:g} seconds\n")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Print every event of a run stream")
    parser.add_argument("run_id", type=uuid.UUID)
    parser.add_argument("--email", help="user to sign for; defaults to the bootstrap admin")
    parser.add_argument("--token", help="API token to use instead of signing one")
    parser.add_argument("--api-url", help="API origin; defaults to TESSA_PUBLIC_API_URL")
    parser.add_argument("--last-seq", type=int, default=0, help="replay events after this seq")
    parser.add_argument("--follow", action="store_true", help="keep going after run.finished")
    parser.add_argument("--timeout", type=float, default=3600, help="seconds before giving up")
    arguments = parser.parse_args()
    return asyncio.run(
        run(
            arguments.run_id,
            arguments.email,
            arguments.token,
            arguments.api_url,
            arguments.last_seq,
            arguments.follow,
            arguments.timeout,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
