import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from tessa_worker.settings import WorkerSettings

WORKER_ROOT = Path(__file__).resolve().parent.parent
ENV_EXAMPLE_PATH = WORKER_ROOT / ".env.example"


@pytest.fixture(autouse=True)
def clean_tessa_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith("TESSA_"):
            monkeypatch.delenv(name)


def test_env_example_loads_and_covers_every_field() -> None:
    loaded = WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    keys = {
        line.partition("=")[0] for line in ENV_EXAMPLE_PATH.read_text(encoding="utf-8").splitlines()
    }
    assert keys == {f"TESSA_{name}".upper() for name in WorkerSettings.model_fields}
    assert len(keys) == 63
    assert loaded.api_internal_url == "http://127.0.0.1:8000"
    assert loaded.laya_timeout_seconds == 10


def test_unknown_process_variable_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESSA_JWT_SECRET", "x")
    with pytest.raises(ValidationError) as caught:
        WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    assert "TESSA_JWT_SECRET" in str(caught.value)


def test_unknown_dotenv_key_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text(
        ENV_EXAMPLE_PATH.read_text(encoding="utf-8") + "TESSA_SIGNING_KEY=x\n",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError) as caught:
        WorkerSettings(_env_file=path)
    assert "tessa_signing_key" in str(caught.value).lower()


def test_prod_rejects_the_dev_only_service_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESSA_ENV", "prod")
    with pytest.raises(ValidationError) as caught:
        WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    assert "service_key still holds a dev-only- placeholder in prod" in str(caught.value)


def test_prod_rejects_the_dev_only_vault_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESSA_ENV", "prod")
    with pytest.raises(ValidationError) as caught:
        WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    assert "vault_key still holds a dev-only- placeholder in prod" in str(caught.value)


def test_vault_key_must_be_a_fernet_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESSA_VAULT_KEY", "dev-only-not-a-fernet-key-0123456789abcdef")
    with pytest.raises(ValidationError) as caught:
        WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    assert "vault_key must be a urlsafe base64 Fernet key of 32 bytes" in str(caught.value)


def test_worker_and_api_examples_share_the_vault_key() -> None:
    api_example = WORKER_ROOT.parent / "api" / ".env.example"
    api_line = next(
        line
        for line in api_example.read_text(encoding="utf-8").splitlines()
        if line.startswith("TESSA_VAULT_KEY=")
    )
    worker_line = next(
        line
        for line in ENV_EXAMPLE_PATH.read_text(encoding="utf-8").splitlines()
        if line.startswith("TESSA_VAULT_KEY=")
    )
    assert api_line == worker_line


def test_data_dir_is_resolved_to_an_absolute_path() -> None:
    loaded = WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.data_dir.is_absolute()


def test_short_service_key_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESSA_SERVICE_KEY", "too-short")
    with pytest.raises(ValidationError) as caught:
        WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    assert "service_key must be at least 32 bytes" in str(caught.value)


def test_stage_two_worker_values_load_from_the_example() -> None:
    loaded = WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.step_max_payload_bytes == 262144
    assert loaded.browser_max_contexts == 4
    assert loaded.browser_headless is True
    assert loaded.scenario_timeout_seconds == 300
    assert loaded.run_max_concurrency == 4
    assert loaded.artifact_retention_days == 30
    assert (loaded.live_grid_max_fps, loaded.live_grid_quality, loaded.live_grid_max_width) == (
        4,
        60,
        640,
    )
    assert (loaded.live_focus_max_fps, loaded.live_focus_quality, loaded.live_focus_max_width) == (
        10,
        75,
        1280,
    )


def test_the_worker_live_keys_equal_the_api_live_keys() -> None:
    api_example = WORKER_ROOT.parent / "api" / ".env.example"
    api = dict(
        line.partition("=")[::2]
        for line in api_example.read_text(encoding="utf-8").splitlines()
        if line
    )
    worker = dict(
        line.partition("=")[::2]
        for line in ENV_EXAMPLE_PATH.read_text(encoding="utf-8").splitlines()
        if line
    )
    live_keys = [key for key in worker if key.startswith("TESSA_LIVE_")]
    assert len(live_keys) == 6
    assert all(api[key] == worker[key] for key in live_keys)
    assert api["TESSA_RUN_MAX_CONCURRENCY"] == worker["TESSA_RUN_MAX_CONCURRENCY"]
    assert api["TESSA_ARTIFACT_RETENTION_DAYS"] == worker["TESSA_ARTIFACT_RETENTION_DAYS"]


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("TESSA_STEP_MAX_PAYLOAD_BYTES", "0"),
        ("TESSA_BROWSER_MAX_CONTEXTS", "0"),
        ("TESSA_SCENARIO_TIMEOUT_SECONDS", "0"),
        ("TESSA_BROWSER_HEADLESS", "sometimes"),
    ],
)
def test_stage_two_worker_limits_must_be_sensible(
    monkeypatch: pytest.MonkeyPatch, key: str, value: str
) -> None:
    monkeypatch.setenv(key, value)
    with pytest.raises(ValidationError):
        WorkerSettings(_env_file=ENV_EXAMPLE_PATH)
