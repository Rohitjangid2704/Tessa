import argparse
import asyncio
import getpass
import sys

from tessa_api.auth.users import DuplicateEmailError, create_user
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.schemas.enums import UserRole
from tessa_api.settings import load_settings

MIN_PASSWORD_LENGTH = 12


def read_password(from_stdin: bool) -> str:
    if from_stdin:
        return sys.stdin.readline().rstrip("\r\n")
    first = getpass.getpass("Password: ")
    second = getpass.getpass("Repeat password: ")
    if first != second:
        raise SystemExit("passwords do not match")
    return first


async def run(email: str, name: str, role: UserRole, password: str) -> int:
    settings = load_settings()
    engine = create_engine(settings.database_url)
    try:
        async with create_session_factory(engine)() as session:
            user = await create_user(session, email, name, password, role)
    except DuplicateEmailError:
        sys.stderr.write(f"a user with email {email} already exists\n")
        return 1
    finally:
        await engine.dispose()
    sys.stdout.write(f"created {user.role.value} {user.email} ({user.id})\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a Tessa user")
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--role", choices=[role.value for role in UserRole], default="member")
    parser.add_argument(
        "--password-stdin",
        action="store_true",
        help="read the password from the first line of stdin instead of prompting",
    )
    arguments = parser.parse_args()
    password = read_password(arguments.password_stdin)
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"password must be at least {MIN_PASSWORD_LENGTH} characters")
    return asyncio.run(run(arguments.email, arguments.name, UserRole(arguments.role), password))


if __name__ == "__main__":
    raise SystemExit(main())
