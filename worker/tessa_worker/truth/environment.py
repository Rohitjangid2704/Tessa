import os
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from tessa_worker.adapters.auth import ResolvedEnvironment
from tessa_worker.adapters.redact import Redactor
from tessa_worker.truth.errors import SeedFailure, SeedFailureCode

BASE_VARIABLE_NAMES = frozenset(
    {
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "HOME",
    }
)
RESERVED_PREFIX = "TESSA_"
PLACEHOLDER_PATTERN = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")
PATH_NAME = "PATH"


def search_path(environment: Mapping[str, str]) -> str:
    return next((value for name, value in environment.items() if name.upper() == PATH_NAME), "")


def is_reserved(name: str) -> bool:
    return name.upper() in BASE_VARIABLE_NAMES or name.upper().startswith(RESERVED_PREFIX)


@dataclass(frozen=True, slots=True)
class SeedEnvironment:
    variables: Mapping[str, str] = field(repr=False)
    secret_names: frozenset[str]

    def require(self, name: str) -> str:
        value = self.variables.get(name)
        if value is None:
            raise SeedFailure(
                SeedFailureCode.env_missing,
                f"variable {name} has no value in the environment of the target",
            )
        return value

    def substitute(self, text: str) -> str:
        return PLACEHOLDER_PATTERN.sub(lambda match: self.require(match.group(1)), text)

    def redactor(self) -> Redactor:
        return Redactor(
            {name: self.variables[name] for name in self.secret_names if name in self.variables}
        )

    def child_environment(
        self,
        parent: Mapping[str, str],
        home: Path,
        path_prefix: Sequence[str] = (),
    ) -> dict[str, str]:
        child = {
            name: value for name, value in parent.items() if name.upper() in BASE_VARIABLE_NAMES
        }
        child["HOME"] = str(home)
        if path_prefix:
            path_key = next((name for name in child if name.upper() == PATH_NAME), PATH_NAME)
            existing = child.get(path_key, "")
            child[path_key] = os.pathsep.join([*path_prefix, *([existing] if existing else [])])
        child.update(self.variables)
        return child


def seed_environment(
    resolved: ResolvedEnvironment, declared_names: Iterable[str]
) -> SeedEnvironment:
    variables: dict[str, str] = {}
    secret_names: set[str] = set()
    for name in declared_names:
        if is_reserved(name):
            continue
        found = resolved.get(name)
        if found is None:
            continue
        variables[name] = found.value
        if found.secret:
            secret_names.add(name)
    return SeedEnvironment(variables, frozenset(secret_names))
