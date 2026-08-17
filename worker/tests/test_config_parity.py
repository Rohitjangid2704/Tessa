import importlib.util
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml

from tessa_api.settings import DEV_ONLY_PREFIX
from tessa_worker.settings import WorkerSettings
from tests.support import COMPOSE_PATH, REPO_ROOT, WORKER_ENV_EXAMPLE, WORKER_ROOT

COMPOSE_OVERRIDES_THE_WORKER_MUST_DECLARE = frozenset(
    {
        "TESSA_DATABASE_URL",
        "TESSA_TEMPORAL_ADDRESS",
        "TESSA_API_INTERNAL_URL",
        "TESSA_LAYA_URL",
        "TESSA_BROWSER_HEADLESS",
    }
)
ENTRY_POINT_PATTERN = re.compile(r'^CMD \["python", "-m", "([\w.]+)"\]$', re.MULTILINE)


def env_file_keys(path: Path) -> list[str]:
    return [
        line.partition("=")[0]
        for line in path.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    ]


def settings_keys() -> set[str]:
    return {f"TESSA_{name}".upper() for name in WorkerSettings.model_fields}


def compose_worker_environment_keys() -> set[str]:
    document = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
    environment: Any = document["services"]["worker"].get("environment", {})
    if isinstance(environment, Mapping):
        return {str(key) for key in environment}
    return {str(entry).partition("=")[0] for entry in environment}


def test_the_example_has_no_duplicate_keys() -> None:
    keys = env_file_keys(WORKER_ENV_EXAMPLE)
    assert len(keys) == len(set(keys))


def test_every_settings_field_is_a_key_in_the_example_and_there_are_no_extra_keys() -> None:
    keys = set(env_file_keys(WORKER_ENV_EXAMPLE))
    assert settings_keys() - keys == set()
    assert keys - settings_keys() == set()


def test_every_compose_override_of_the_worker_is_an_example_key_and_a_settings_field() -> None:
    overrides = {key for key in compose_worker_environment_keys() if key.startswith("TESSA_")}
    assert overrides >= COMPOSE_OVERRIDES_THE_WORKER_MUST_DECLARE
    assert overrides - set(env_file_keys(WORKER_ENV_EXAMPLE)) == set()
    assert overrides - settings_keys() == set()


def test_every_secret_in_the_example_is_a_dev_only_placeholder() -> None:
    loaded = WorkerSettings(_env_file=WORKER_ENV_EXAMPLE)
    for name in loaded.key_secret_fields:
        assert loaded.secret_value(name).startswith(DEV_ONLY_PREFIX), name
    assert DEV_ONLY_PREFIX in loaded.database_url.get_secret_value()


def test_the_dockerfile_entry_point_is_a_module_that_exists() -> None:
    dockerfile = (WORKER_ROOT / "Dockerfile").read_text(encoding="utf-8")
    [module] = ENTRY_POINT_PATTERN.findall(dockerfile)
    assert importlib.util.find_spec(module) is not None


def test_dev_script_starts_the_worker_with_the_same_module() -> None:
    script = (REPO_ROOT / "deploy" / "dev.ps1").read_text(encoding="utf-8")
    assert '"python", "-m", "tessa_worker.main"' in script
