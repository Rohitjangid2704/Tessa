import os
import re
import shlex
import shutil
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from tessa_worker.truth.environment import SeedEnvironment, search_path
from tessa_worker.truth.errors import SeedFailure, SeedFailureCode
from tessa_worker.truth.material import SeedFiles
from tessa_worker.truth.output import output_excerpt, retained_bytes
from tessa_worker.truth.process import run_process
from tessa_worker.truth.seed_runner import PYTHON_ARGUMENTS, BashLocator
from tessa_worker.truth.shell import bash_path_entries, locate_bash
from tessa_worker.truth.workspace import seed_workspace

HASH_PATTERN = re.compile(r"^[A-Za-z0-9:_-]{8,128}$")
SHELL_COMMANDS = frozenset({"bash", "sh"})
PYTHON_COMMANDS = frozenset({"python", "python3", "py"})
SHELL_SUFFIX = ".sh"
PYTHON_SUFFIX = ".py"
HASH_RULE = "the last non-empty line of the output must be 8 to 128 characters of [A-Za-z0-9:_-]"


def parse_hash_output(output: str) -> str | None:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return None
    return lines[-1] if HASH_PATTERN.match(lines[-1]) else None


def split_command(command: str, environment: SeedEnvironment) -> list[str]:
    try:
        tokens = shlex.split(command)
    except ValueError as error:
        raise SeedFailure(
            SeedFailureCode.script_unsupported, f"the hash command cannot be parsed: {error}"
        ) from error
    if not tokens:
        raise SeedFailure(SeedFailureCode.hook_missing, "the hash command is empty")
    return [environment.substitute(token) for token in tokens]


def has_directory(token: str) -> bool:
    return "/" in token or "\\" in token


class HashCommandRunner:
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

    def require_bash(self) -> str:
        bash = self.bash_locator(self.parent())
        if bash is None:
            raise SeedFailure(
                SeedFailureCode.hook_missing,
                "the hash command needs bash on PATH (Git Bash on Windows)",
            )
        return bash

    def resolve_arguments(
        self, arguments: Sequence[str], workspace: Path, search_path: str
    ) -> list[str]:
        head, *rest = arguments
        lowered = head.lower()
        if lowered in SHELL_COMMANDS:
            return [self.require_bash(), *rest]
        if lowered in PYTHON_COMMANDS:
            return [sys.executable, *PYTHON_ARGUMENTS, *rest]
        if has_directory(head):
            local = workspace / head
            if local.is_file() and local.suffix.lower() == SHELL_SUFFIX:
                return [self.require_bash(), head, *rest]
            if local.is_file() and local.suffix.lower() == PYTHON_SUFFIX:
                return [sys.executable, *PYTHON_ARGUMENTS, head, *rest]
            if local.is_file():
                return [str(local), *rest]
        found = shutil.which(head, path=search_path)
        if found is None:
            raise SeedFailure(
                SeedFailureCode.hook_missing, f"hash command {head!r} was not found on PATH"
            )
        return [found, *rest]

    def path_prefix(self, arguments: Sequence[str]) -> list[str]:
        needs_bash = arguments[0].lower() in SHELL_COMMANDS or any(
            token.endswith(SHELL_SUFFIX) for token in arguments[:2]
        )
        if not needs_bash:
            return []
        bash = self.bash_locator(self.parent())
        return bash_path_entries(bash) if bash is not None else []

    async def run(self, seed: SeedFiles, environment: SeedEnvironment) -> str:
        if seed.hash_command is None:
            raise SeedFailure(SeedFailureCode.hook_missing, "the seed has no hash command")
        arguments = split_command(seed.hash_command, environment)
        redactor = environment.redactor()
        async with seed_workspace(seed.files) as workspace:
            child = environment.child_environment(
                self.parent(), workspace, self.path_prefix(arguments)
            )
            command = self.resolve_arguments(arguments, workspace, search_path(child))
            result = await run_process(
                command,
                workspace,
                child,
                self.timeout_seconds,
                retained_bytes(redactor),
                merge_stderr=False,
            )
        if result.exit_code != 0:
            excerpt = output_excerpt([result.stdout, result.stderr], redactor)
            raise SeedFailure(
                SeedFailureCode.script_failed,
                f"the hash command exited with code {result.exit_code}: {excerpt}",
            )
        observed = parse_hash_output(output_excerpt([result.stdout], redactor))
        if observed is None:
            raise SeedFailure(
                SeedFailureCode.hash_invalid, f"the hash command printed no hash: {HASH_RULE}"
            )
        return observed
