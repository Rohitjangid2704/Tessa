import argparse
import asyncio
import sys

from tessa_api.auth.jwt import DEFAULT_TTL_SECONDS, encode_api_token
from tessa_api.auth.users import get_user_by_email
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.settings import load_settings


async def run(email: str | None, ttl_seconds: int) -> int:
    settings = load_settings()
    login = email or settings.bootstrap_admin_email
    if not login:
        sys.stderr.write("pass --email or set TESSA_BOOTSTRAP_ADMIN_EMAIL\n")
        return 2
    engine = create_engine(settings.database_url)
    try:
        async with create_session_factory(engine)() as session:
            user = await get_user_by_email(session, login)
    finally:
        await engine.dispose()
    if user is None:
        sys.stderr.write(f"no user with email {login}\n")
        return 1
    sys.stdout.write(encode_api_token(settings, user.id, user.email, user.role, ttl_seconds) + "\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Print a signed API token for local use")
    parser.add_argument("--email", help="user to sign for; defaults to the bootstrap admin")
    parser.add_argument("--ttl", type=int, default=DEFAULT_TTL_SECONDS, help="seconds")
    arguments = parser.parse_args()
    return asyncio.run(run(arguments.email, arguments.ttl))


if __name__ == "__main__":
    raise SystemExit(main())
