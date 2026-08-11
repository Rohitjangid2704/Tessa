from pathlib import Path
from typing import Any

import pytest
import yaml

from tests.support import API_ROOT

REPO_ROOT = API_ROOT.parent
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
SERVICE_ENV_EXAMPLES = {
    "api": API_ROOT / ".env.example",
    "worker": REPO_ROOT / "worker" / ".env.example",
}


def compose_services() -> dict[str, Any]:
    services: dict[str, Any] = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))["services"]
    return services


def example_keys(path: Path) -> set[str]:
    return {
        line.partition("=")[0] for line in path.read_text(encoding="utf-8").splitlines() if line
    }


@pytest.mark.parametrize("service", ["api", "worker"])
def test_compose_overrides_are_keys_the_service_settings_know(service: str) -> None:
    environment = compose_services()[service]["environment"]
    tessa_keys = {key for key in environment if key.startswith("TESSA_")}
    assert tessa_keys
    assert tessa_keys <= example_keys(SERVICE_ENV_EXAMPLES[service])


@pytest.mark.parametrize("service", ["api", "worker"])
def test_compose_points_the_data_dir_at_the_shared_volume(service: str) -> None:
    definition = compose_services()[service]
    assert definition["environment"]["TESSA_DATA_DIR"] == "/data"
    assert "tessa-data:/data" in definition["volumes"]


@pytest.mark.parametrize("service", ["api", "worker"])
def test_compose_services_load_their_env_file(service: str) -> None:
    env_files = compose_services()[service]["env_file"]
    assert any(entry["path"] == f"../{service}/.env" for entry in env_files)


def test_api_and_worker_share_one_vault_key_and_data_volume_in_the_examples() -> None:
    api = {
        line.partition("=")[0]: line.partition("=")[2]
        for line in SERVICE_ENV_EXAMPLES["api"].read_text(encoding="utf-8").splitlines()
    }
    worker = {
        line.partition("=")[0]: line.partition("=")[2]
        for line in SERVICE_ENV_EXAMPLES["worker"].read_text(encoding="utf-8").splitlines()
    }
    assert api["TESSA_VAULT_KEY"] == worker["TESSA_VAULT_KEY"]
    assert api["TESSA_SERVICE_KEY"] == worker["TESSA_SERVICE_KEY"]
    assert api["TESSA_DATA_DIR"] == "./data"
    assert (API_ROOT / api["TESSA_DATA_DIR"]).resolve() == (
        REPO_ROOT / "worker" / worker["TESSA_DATA_DIR"]
    ).resolve()
