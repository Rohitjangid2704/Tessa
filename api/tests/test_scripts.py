import os
import subprocess
import sys

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from tessa_api.db.models import User
from tessa_api.schemas.enums import UserRole
from tests.support import API_ROOT, suite_env_values

pytestmark = pytest.mark.integration

SCRIPT_PASSWORD = "dev-only-scripted-password-1"


def script_environment() -> dict[str, str]:
    return {**os.environ, **suite_env_values()}


def run_script(name: str, *arguments: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, f"scripts/{name}.py", *arguments],
        cwd=API_ROOT,
        env=script_environment(),
        input=stdin,
        capture_output=True,
        text=True,
        check=False,
    )


def create_user_arguments(email: str, name: str, *extra: str) -> tuple[str, ...]:
    return ("--email", email, "--name", name, "--password-stdin", *extra)


async def test_create_user_reads_the_password_from_stdin(db_app: FastAPI) -> None:
    result = run_script(
        "create_user",
        *create_user_arguments("scripted@tessa.test", "Scripted", "--role", "viewer"),
        stdin=f"{SCRIPT_PASSWORD}\n",
    )
    assert result.returncode == 0, result.stderr
    assert "created viewer scripted@tessa.test" in result.stdout
    assert SCRIPT_PASSWORD not in result.stdout + result.stderr
    async with db_app.state.session_factory() as session:
        user = await session.scalar(select(User).where(User.email == "scripted@tessa.test"))
    assert user is not None
    assert user.role is UserRole.viewer
    assert user.password_hash.startswith("$argon2id$")


async def test_create_user_rejects_duplicates_and_short_passwords(db_app: FastAPI) -> None:
    arguments = create_user_arguments("dup@tessa.test", "Dup")
    first = run_script("create_user", *arguments, stdin=f"{SCRIPT_PASSWORD}\n")
    second = run_script("create_user", *arguments, stdin=f"{SCRIPT_PASSWORD}\n")
    short = run_script(
        "create_user",
        *create_user_arguments("short@tessa.test", "Short"),
        stdin="short\n",
    )
    assert first.returncode == 0
    assert second.returncode == 1
    assert "already exists" in second.stderr
    assert short.returncode != 0
    assert "at least 12 characters" in short.stderr


async def test_dev_token_signs_a_token_the_api_accepts(
    db_app: FastAPI, client: httpx.AsyncClient
) -> None:
    created = run_script(
        "create_user",
        *create_user_arguments("tokened@tessa.test", "Tokened", "--role", "admin"),
        stdin=f"{SCRIPT_PASSWORD}\n",
    )
    assert created.returncode == 0, created.stderr
    token = run_script("dev_token", "--email", "tokened@tessa.test")
    assert token.returncode == 0, token.stderr
    response = await client.get(
        "/api/v1/users/me", headers={"Authorization": f"Bearer {token.stdout.strip()}"}
    )
    assert response.status_code == 200
    assert response.json()["email"] == "tokened@tessa.test"
    assert response.json()["role"] == "admin"


async def test_dev_token_for_unknown_user_fails(db_app: FastAPI) -> None:
    result = run_script("dev_token", "--email", "ghost@tessa.test")
    assert result.returncode == 1
    assert "no user" in result.stderr
