import os
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from tessa_api.schemas.enums import ModelRole
from tessa_worker.settings import WorkerSettings
from tests.support import API_ENV_EXAMPLE, COMPOSE_PATH, REPO_ROOT, WORKER_ENV_EXAMPLE

ROLES = ["JUDGE", "JUDGE_TIEBREAK"]
ROLE_KEY_PREFIXES = ["MODEL", "EFFORT", "MAX_USD", "MAX_OUTPUT_TOKENS", "TIMEOUT_SECONDS"]
ROLE_KEYS = [f"TESSA_{prefix}_{role}" for role in ROLES for prefix in ROLE_KEY_PREFIXES]
STAGE_FOUR_PLAIN_KEYS = [
    "TESSA_OPENAI_API_KEY",
    "TESSA_ANTHROPIC_API_KEY",
    "TESSA_PROBES_DIR",
    "TESSA_PROBE_CONFIDENCE_THRESHOLD",
    "TESSA_JUDGE_ESCALATE_BELOW",
    "TESSA_LABEL_AUDIT_RATE",
    "TESSA_STUB_MODELS",
]
SHARED_KEYS = [*ROLE_KEYS, *STAGE_FOUR_PLAIN_KEYS, "TESSA_ORACLE_MAX_ROWS"]
STRONG_SECRETS = {
    "TESSA_SERVICE_KEY": "prod-service-key-0123456789abcdefghijkl",
    "TESSA_VAULT_KEY": "qS3tQ9o7k2mXgJ5bF8nYw1zA4cE6hL0uRvT2dP9iKxU=",
    "TESSA_DATABASE_URL": "postgresql+asyncpg://tessa:prod-password@db.internal:5432/tessa",
}


@pytest.fixture(autouse=True)
def clean_tessa_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith("TESSA_"):
            monkeypatch.delenv(name)


def example_pairs(path: Path) -> dict[str, str]:
    return dict(
        line.partition("=")[::2] for line in path.read_text(encoding="utf-8").splitlines() if line
    )


def write_env(tmp_path: Path, replace: dict[str, str] | None = None, extra: str = "") -> Path:
    replacements = replace or {}
    lines = []
    for line in WORKER_ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        key = line.partition("=")[0]
        lines.append(f"{key}={replacements[key]}" if key in replacements else line)
    path = tmp_path / ".env"
    path.write_text("\n".join(lines) + "\n" + extra, encoding="utf-8")
    return path


def test_the_worker_example_carries_the_shared_keys_with_the_api_values() -> None:
    api = example_pairs(API_ENV_EXAMPLE)
    worker = example_pairs(WORKER_ENV_EXAMPLE)
    assert len(ROLE_KEYS) == 10
    for key in SHARED_KEYS:
        assert worker[key] == api[key], key


def test_the_worker_only_stage_three_keys_are_in_the_worker_example_alone() -> None:
    api = example_pairs(API_ENV_EXAMPLE)
    worker = example_pairs(WORKER_ENV_EXAMPLE)
    assert worker["TESSA_ORACLE_STATEMENT_TIMEOUT_MS"] == "10000"
    assert worker["TESSA_SEED_SCRIPT_TIMEOUT_SECONDS"] == "300"
    assert "TESSA_ORACLE_STATEMENT_TIMEOUT_MS" not in api
    assert "TESSA_SEED_SCRIPT_TIMEOUT_SECONDS" not in api


def test_the_worker_loads_the_stage_three_and_four_values() -> None:
    loaded = WorkerSettings(_env_file=WORKER_ENV_EXAMPLE)
    assert loaded.oracle_statement_timeout_ms == 10000
    assert loaded.oracle_max_rows == 200
    assert loaded.seed_script_timeout_seconds == 300
    assert loaded.stub_models is False
    assert loaded.probe_confidence_threshold == 0.75
    assert loaded.judge_escalate_below == 0.6
    assert loaded.label_audit_rate == 0.05
    assert loaded.probes_dir == (REPO_ROOT / "probes").resolve()
    assert loaded.optional_secret("openai_api_key") is None
    assert loaded.optional_secret("anthropic_api_key") is None


def test_every_role_resolves_to_a_complete_boot_default() -> None:
    loaded = WorkerSettings(_env_file=WORKER_ENV_EXAMPLE)
    for role in ModelRole:
        defaults = loaded.role_defaults(role)
        assert defaults.model
        assert defaults.max_usd > 0
        assert defaults.max_output_tokens > 0
        assert defaults.timeout_seconds > 0
    judge = loaded.role_defaults(ModelRole.judge)
    assert (judge.max_usd, judge.max_output_tokens, judge.timeout_seconds) == (0.05, 800, 60)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("TESSA_ORACLE_STATEMENT_TIMEOUT_MS", "0"),
        ("TESSA_SEED_SCRIPT_TIMEOUT_SECONDS", "0"),
        ("TESSA_ORACLE_MAX_ROWS", "0"),
        ("TESSA_STUB_MODELS", "maybe"),
        ("TESSA_EFFORT_JUDGE", "extreme"),
        ("TESSA_PROBE_CONFIDENCE_THRESHOLD", "1.5"),
    ],
)
def test_invalid_values_are_rejected(tmp_path: Path, key: str, value: str) -> None:
    with pytest.raises(ValidationError):
        WorkerSettings(_env_file=write_env(tmp_path, {key: value}))


@pytest.mark.parametrize(
    "key",
    [
        "TESSA_ORACLE_STATEMENT_TIMEOUT_MS",
        "TESSA_SEED_SCRIPT_TIMEOUT_SECONDS",
        "TESSA_STUB_MODELS",
        "TESSA_MODEL_JUDGE",
    ],
)
def test_a_missing_key_fails_startup(tmp_path: Path, key: str) -> None:
    path = tmp_path / ".env"
    kept = [
        line
        for line in WORKER_ENV_EXAMPLE.read_text(encoding="utf-8").splitlines()
        if not line.startswith(f"{key}=")
    ]
    path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    with pytest.raises(ValidationError):
        WorkerSettings(_env_file=path)


def test_prod_refuses_stub_models_in_the_worker_too(tmp_path: Path) -> None:
    prod = {"TESSA_ENV": "prod", **STRONG_SECRETS}
    path = write_env(tmp_path, {**prod, "TESSA_STUB_MODELS": "true"})
    with pytest.raises(ValidationError) as caught:
        WorkerSettings(_env_file=path)
    assert "stub_models must be false when env is prod" in str(caught.value)
    assert WorkerSettings(_env_file=write_env(tmp_path, prod)).stub_models is False


def test_the_worker_compose_service_pins_stub_models_off_and_holds_no_provider_key() -> None:
    text = COMPOSE_PATH.read_text(encoding="utf-8")
    environment = yaml.safe_load(text)["services"]["worker"]["environment"]
    assert environment["TESSA_STUB_MODELS"] == "false"
    assert "API_KEY" not in text
    dockerfile = (REPO_ROOT / "worker" / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY --chown=tessa:tessa probes/ /app/probes/" in dockerfile
