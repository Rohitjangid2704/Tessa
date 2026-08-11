import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml

from tessa_api.settings import DEV_ONLY_PREFIX, Settings
from tests.support import API_ROOT

REPO_ROOT = API_ROOT.parent
ENV_EXAMPLE = API_ROOT / ".env.example"
ENV_TEST = API_ROOT / ".env.test"
WORKER_ENV_EXAMPLE = REPO_ROOT / "worker" / ".env.example"
DEPLOY_ENV_EXAMPLE = REPO_ROOT / "deploy" / ".env.example"
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
APPS_PROFILE_SERVICES = ("api", "worker")
PER_SERVICE_PATH_KEYS = frozenset({"TESSA_DATA_DIR"})
COMPOSE_VARIABLE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)")


def env_file_pairs(path: Path) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            key, _, value = line.partition("=")
            pairs.append((key, value))
    return pairs


def env_file_keys(path: Path) -> list[str]:
    return [key for key, _ in env_file_pairs(path)]


def settings_keys() -> set[str]:
    return {f"TESSA_{name}".upper() for name in Settings.model_fields}


def compose_service(name: str) -> Mapping[str, Any]:
    document = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
    service: Mapping[str, Any] = document["services"][name]
    return service


def compose_environment_keys(service_name: str) -> set[str]:
    environment = compose_service(service_name).get("environment", {})
    if isinstance(environment, Mapping):
        return {str(key) for key in environment}
    return {str(entry).partition("=")[0] for entry in environment}


def test_the_example_has_no_duplicate_keys() -> None:
    keys = env_file_keys(ENV_EXAMPLE)
    assert len(keys) == len(set(keys))


def test_every_settings_field_is_a_key_in_the_example_and_there_are_no_extra_keys() -> None:
    keys = set(env_file_keys(ENV_EXAMPLE))
    assert settings_keys() - keys == set()
    assert keys - settings_keys() == set()


def test_the_example_loads_as_a_complete_settings_object() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE)
    assert loaded.env == "dev"


def test_the_test_env_file_has_exactly_the_keys_of_the_example() -> None:
    assert set(env_file_keys(ENV_TEST)) == set(env_file_keys(ENV_EXAMPLE))


def test_every_secret_in_the_example_is_a_dev_only_placeholder() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE)
    for name in (*Settings.key_secret_fields, *Settings.credential_fields):
        assert loaded.secret_value(name).startswith(DEV_ONLY_PREFIX), name
    assert "dev-only-" in loaded.database_url.get_secret_value()


@pytest.mark.parametrize("service", APPS_PROFILE_SERVICES)
def test_compose_overrides_of_the_service_are_keys_its_example_declares(service: str) -> None:
    example = ENV_EXAMPLE if service == "api" else WORKER_ENV_EXAMPLE
    overrides = {key for key in compose_environment_keys(service) if key.startswith("TESSA_")}
    assert overrides
    assert overrides - set(env_file_keys(example)) == set()


def test_compose_variables_are_defined_in_the_deploy_example() -> None:
    referenced = set(COMPOSE_VARIABLE.findall(COMPOSE_PATH.read_text(encoding="utf-8")))
    defined = set(env_file_keys(DEPLOY_ENV_EXAMPLE))
    assert referenced
    assert referenced - defined == set()


def test_keys_shared_by_the_api_and_worker_examples_hold_the_same_value() -> None:
    api = dict(env_file_pairs(ENV_EXAMPLE))
    worker = dict(env_file_pairs(WORKER_ENV_EXAMPLE))
    shared = (set(api) & set(worker)) - PER_SERVICE_PATH_KEYS
    assert shared
    assert {key: (api[key], worker[key]) for key in shared if api[key] != worker[key]} == {}


def test_the_api_and_worker_agree_on_where_temporal_and_the_task_queue_are() -> None:
    api = dict(env_file_pairs(ENV_EXAMPLE))
    worker = dict(env_file_pairs(WORKER_ENV_EXAMPLE))
    for key in (
        "TESSA_TEMPORAL_ADDRESS",
        "TESSA_TEMPORAL_NAMESPACE",
        "TESSA_TEMPORAL_TASK_QUEUE",
    ):
        assert api[key] == worker[key], key
