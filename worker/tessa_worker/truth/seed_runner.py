import asyncio
import os
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath

import asyncpg

from tessa_worker.adapters.redact import Redactor
from tessa_worker.truth.environment import SeedEnvironment
from tessa_worker.truth.errors import SeedFailure, SeedFailureCode
from tessa_worker.truth.material import SeedFiles
from tessa_worker.truth.output import output_excerpt, retained_bytes
from tessa_worker.truth.process import TailSnapshot, run_process
from tessa_worker.truth.shell import bash_path_entries, locate_bash
from tessa_worker.truth.workspace import seed_workspace

SQL_SUFFIX = ".sql"
PYTHON_SUFFIX = ".py"
SHELL_SUFFIX = ".sh"
PYTHON_ARGUMENTS = ("-X", "utf8")
CONNECT_TIMEOUT_SECONDS = 30.0
CLOSE_TIMEOUT_SECONDS = 5.0
DRIVER_SCHEME_SUFFIX = "+asyncpg"
FAILED_EXIT_CODE = 1
SUCCESS_EXIT_CODE = 0

BashLocator = Callable[[Mapping[str, str]], str | None]


@dataclass(frozen=True, slots=True)
class ResetOutcome:
    exit_code: int
    output_excerpt: str


def normalise_dsn(dsn: str) -> str:
    scheme, separator, rest = dsn.partition("://")
    return f"{scheme.removesuffix(DRIVER_SCHEME_SUFFIX)}{separator}{rest}"


def describe_database_error(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"


async def close_connection(connection: asyncpg.Connection) -> None:
    try:
        await asyncio.wait_for(connection.close(), CLOSE_TIMEOUT_SECONDS)
    except Exception:
        connection.terminate()


def script_text(seed: SeedFiles, path: str) -> str:
    content = seed.files.get(path)
    if content is None:
        raise SeedFailure(
            SeedFailureCode.material_missing, f"reset script {path} is not in the bundle"
        )
    return content.decode("utf-8")


async def run_sql_script(
    script: str, dsn: str, timeout_seconds: float, redactor: Redactor
) -> ResetOutcome:
    try:
        async with asyncio.timeout(timeout_seconds):
            connection = await asyncpg.connect(
                normalise_dsn(dsn), timeout=min(timeout_seconds, CONNECT_TIMEOUT_SECONDS)
            )
            try:
                async with connection.transaction():
                    await connection.execute(script)
            finally:
                await close_connection(connection)
    except TimeoutError:
        raise SeedFailure(
            SeedFailureCode.timeout,
            f"the reset script did not finish within {timeout_seconds:g} seconds and its "
            "transaction was rolled back",
        ) from None
    except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, ValueError) as error:
        message = describe_database_error(error).encode("utf-8")
        return ResetOutcome(
            FAILED_EXIT_CODE, output_excerpt([TailSnapshot(message, False)], redactor)
        )
    return ResetOutcome(SUCCESS_EXIT_CODE, "")


class SeedRunner:
    def __init__(
        self,
        timeout_seconds: int,
        parent_environment: Mapping[str, str] | None = None,
        bash_locator: BashLocator = locate_bash,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.parent_environment = parent_environment
        self.bash_locator = bash_locator

    def parent(self) -> Mapping[str, str]:
        return os.environ if self.parent_environment is None else self.parent_environment

    async def reset(self, seed: SeedFiles, environment: SeedEnvironment) -> ResetOutcome:
        path = seed.reset_script_path
        if path is None:
            raise SeedFailure(SeedFailureCode.hook_missing, "the seed has no reset script")
        suffix = PurePosixPath(path).suffix.lower()
        if suffix == SQL_SUFFIX:
            return await self.reset_with_sql(seed, path, environment)
        if suffix in (PYTHON_SUFFIX, SHELL_SUFFIX):
            return await self.reset_with_process(seed, path, suffix, environment)
        raise SeedFailure(
            SeedFailureCode.script_unsupported,
            f"reset script {path} must end in .sql, .py or .sh",
        )

    async def reset_with_sql(
        self, seed: SeedFiles, path: str, environment: SeedEnvironment
    ) -> ResetOutcome:
        if seed.dsn_env is None:
            raise SeedFailure(
                SeedFailureCode.env_missing,
                "a .sql reset script needs seeds.dsn_env in the manifest",
            )
        dsn = environment.require(seed.dsn_env)
        return await run_sql_script(
            script_text(seed, path), dsn, self.timeout_seconds, environment.redactor()
        )

    def interpreter(self, suffix: str) -> tuple[list[str], list[str]]:
        if suffix == PYTHON_SUFFIX:
            return [sys.executable, *PYTHON_ARGUMENTS], []
        bash = self.bash_locator(self.parent())
        if bash is None:
            raise SeedFailure(
                SeedFailureCode.hook_missing,
                "a .sh reset script needs bash on PATH (Git Bash on Windows)",
            )
        return [bash], bash_path_entries(bash)

    async def reset_with_process(
        self, seed: SeedFiles, path: str, suffix: str, environment: SeedEnvironment
    ) -> ResetOutcome:
        head, path_prefix = self.interpreter(suffix)
        redactor = environment.redactor()
        async with seed_workspace(seed.files) as workspace:
            result = await run_process(
                [*head, path],
                workspace,
                environment.child_environment(self.parent(), workspace, path_prefix),
                self.timeout_seconds,
                retained_bytes(redactor),
                merge_stderr=True,
            )
        return ResetOutcome(result.exit_code, output_excerpt([result.stdout], redactor))
