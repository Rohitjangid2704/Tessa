import re
from pathlib import Path

import pytest
import yaml
from pydantic import SecretStr, ValidationError

from tessa_api.schemas.enums import Effort, ModelRole
from tessa_api.settings import Settings
from tests.support import API_ROOT, ENV_EXAMPLE_PATH, ENV_TEST_PATH
from tests.test_settings import production_overrides, write_env

REPO_ROOT = API_ROOT.parent
WORKER_ENV_EXAMPLE = REPO_ROOT / "worker" / ".env.example"
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
ROLES = ["JUDGE", "JUDGE_TIEBREAK"]
ROLE_KEY_PREFIXES = ["MODEL", "EFFORT", "MAX_USD", "MAX_OUTPUT_TOKENS", "TIMEOUT_SECONDS"]
ROLE_KEYS = [f"TESSA_{prefix}_{role}" for role in ROLES for prefix in ROLE_KEY_PREFIXES]
PROVIDER_KEYS = ["TESSA_OPENAI_API_KEY", "TESSA_ANTHROPIC_API_KEY"]
STAGE_FOUR_PLAIN_KEYS = [
    "TESSA_OPENAI_API_KEY",
    "TESSA_ANTHROPIC_API_KEY",
    "TESSA_PROBES_DIR",
    "TESSA_PROBE_CONFIDENCE_THRESHOLD",
    "TESSA_JUDGE_ESCALATE_BELOW",
    "TESSA_LABEL_AUDIT_RATE",
    "TESSA_STUB_MODELS",
]


def example_pairs(path: Path) -> dict[str, str]:
    return dict(
        line.partition("=")[::2] for line in path.read_text(encoding="utf-8").splitlines() if line
    )


def test_there_are_ten_role_keys_and_every_one_is_in_the_examples() -> None:
    assert len(ROLE_KEYS) == 10
    api = example_pairs(ENV_EXAMPLE_PATH)
    worker = example_pairs(WORKER_ENV_EXAMPLE)
    test_env = example_pairs(ENV_TEST_PATH)
    for key in [*ROLE_KEYS, *STAGE_FOUR_PLAIN_KEYS, "TESSA_ORACLE_MAX_ROWS"]:
        assert key in api, key
        assert key in worker, key
        assert key in test_env, key


def test_the_role_and_stage_four_values_are_identical_in_the_api_and_worker_examples() -> None:
    api = example_pairs(ENV_EXAMPLE_PATH)
    worker = example_pairs(WORKER_ENV_EXAMPLE)
    for key in [*ROLE_KEYS, *STAGE_FOUR_PLAIN_KEYS, "TESSA_ORACLE_MAX_ROWS"]:
        assert api[key] == worker[key], key


def test_the_example_loads_every_role_as_a_complete_boot_default() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    for role in ModelRole:
        defaults = loaded.role_defaults(role)
        assert defaults.model
        assert defaults.effort in set(Effort)
        assert defaults.max_usd > 0
        assert defaults.max_output_tokens > 0
        assert defaults.timeout_seconds > 0


def test_the_judge_defaults_are_the_contract_defaults() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    for role in (ModelRole.judge, ModelRole.judge_tiebreak):
        defaults = loaded.role_defaults(role)
        assert defaults.max_usd == 0.05
        assert defaults.max_output_tokens == 800
        assert defaults.timeout_seconds == 60


def test_the_tiebreak_role_names_a_model_of_the_other_family() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.role_defaults(ModelRole.judge_tiebreak).model.startswith("claude-")
    assert not loaded.role_defaults(ModelRole.judge).model.startswith("claude-")


def test_no_model_id_is_hard_coded_in_the_settings_code() -> None:
    settings_source = (API_ROOT / "tessa_api" / "settings.py").read_text(encoding="utf-8")
    worker_source = (REPO_ROOT / "worker" / "tessa_worker" / "settings.py").read_text(
        encoding="utf-8"
    )
    for source in (settings_source, worker_source):
        assert not re.search(r"gpt-|claude-|\bo[0-9]-", source)


def test_provider_keys_are_absent_in_every_committed_env_file() -> None:
    for path in (ENV_EXAMPLE_PATH, ENV_TEST_PATH, WORKER_ENV_EXAMPLE):
        pairs = example_pairs(path)
        for key in PROVIDER_KEYS:
            assert pairs[key] == "", (path.name, key)


def test_absent_provider_keys_load_as_none_and_a_set_key_is_returned_but_never_shown() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.optional_secret("openai_api_key") is None
    assert loaded.optional_secret("anthropic_api_key") is None
    with_key = Settings(
        _env_file=ENV_EXAMPLE_PATH, openai_api_key=SecretStr("sk-test-secret-value")
    )
    assert with_key.optional_secret("openai_api_key") == "sk-test-secret-value"
    assert "sk-test-secret-value" not in repr(with_key)
    assert "sk-test-secret-value" not in with_key.model_dump_json()


def test_the_probes_dir_resolves_to_the_repository_probe_bank() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.probes_dir.is_absolute()
    assert loaded.probes_dir == (API_ROOT.parent / "probes").resolve()
    assert loaded.probes_dir.is_dir()


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("TESSA_PROBE_CONFIDENCE_THRESHOLD", "1.5"),
        ("TESSA_PROBE_CONFIDENCE_THRESHOLD", "-0.1"),
        ("TESSA_JUDGE_ESCALATE_BELOW", "2"),
        ("TESSA_LABEL_AUDIT_RATE", "-1"),
        ("TESSA_ORACLE_MAX_ROWS", "0"),
        ("TESSA_STUB_MODELS", "sometimes"),
        ("TESSA_EFFORT_JUDGE", "extreme"),
        ("TESSA_MAX_USD_JUDGE", "0"),
        ("TESSA_MAX_OUTPUT_TOKENS_JUDGE", "0"),
        ("TESSA_TIMEOUT_SECONDS_JUDGE", "0"),
        ("TESSA_MODEL_JUDGE", ""),
        ("TESSA_MAX_USD_JUDGE_TIEBREAK", "free"),
    ],
)
def test_an_invalid_stage_three_or_four_value_is_rejected(
    tmp_path: Path, key: str, value: str
) -> None:
    path = write_env(tmp_path, replace={key: value})
    with pytest.raises(ValidationError):
        Settings(_env_file=path)


@pytest.mark.parametrize(
    "key", [*ROLE_KEYS[::7], *STAGE_FOUR_PLAIN_KEYS, "TESSA_ORACLE_MAX_ROWS"]
)
def test_a_missing_stage_three_or_four_key_fails_startup(tmp_path: Path, key: str) -> None:
    path = tmp_path / ".env"
    kept = [
        line
        for line in ENV_EXAMPLE_PATH.read_text(encoding="utf-8").splitlines()
        if not line.startswith(f"{key}=")
    ]
    path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert key.removeprefix("TESSA_").lower() in str(caught.value).lower()


def test_an_unknown_role_key_is_rejected_like_any_unknown_key(tmp_path: Path) -> None:
    path = write_env(tmp_path, "TESSA_MODEL_ARBITER=gpt-x\n")
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "tessa_model_arbiter" in str(caught.value).lower()


def test_prod_refuses_stub_models(tmp_path: Path) -> None:
    refused = write_env(
        tmp_path, replace={**production_overrides(), "TESSA_STUB_MODELS": "true"}
    )
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=refused)
    assert "stub_models must be false when env is prod" in str(caught.value)


def test_prod_accepts_stub_models_off_and_dev_accepts_them_on(tmp_path: Path) -> None:
    accepted = write_env(tmp_path, replace=production_overrides())
    assert Settings(_env_file=accepted).stub_models is False
    development = write_env(tmp_path, replace={"TESSA_STUB_MODELS": "true"})
    assert Settings(_env_file=development).stub_models is True


def test_the_test_environment_may_enable_stub_models(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_ENV": "test", "TESSA_STUB_MODELS": "true"})
    assert Settings(_env_file=path).stub_models is True


def test_stub_models_are_off_in_every_committed_example() -> None:
    for path in (ENV_EXAMPLE_PATH, WORKER_ENV_EXAMPLE, ENV_TEST_PATH):
        assert example_pairs(path)["TESSA_STUB_MODELS"] == "false", path.name


def compose_environment(service: str) -> dict[str, str]:
    document = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
    environment: dict[str, str] = document["services"][service]["environment"]
    return environment


@pytest.mark.parametrize("service", ["api", "worker"])
def test_the_apps_profile_pins_stub_models_off(service: str) -> None:
    assert compose_environment(service)["TESSA_STUB_MODELS"] == "false"


def test_provider_keys_never_appear_in_the_compose_file() -> None:
    text = COMPOSE_PATH.read_text(encoding="utf-8")
    for key in PROVIDER_KEYS:
        assert key not in text
    assert not re.search(r"sk-|api[_-]?key\s*[:=]", text, re.IGNORECASE)


@pytest.mark.parametrize("service", ["api", "worker"])
def test_the_images_carry_the_probe_bank_the_probes_dir_points_at(service: str) -> None:
    dockerfile = (REPO_ROOT / service / "Dockerfile").read_text(encoding="utf-8")
    ignore = (REPO_ROOT / service / "Dockerfile.dockerignore").read_text(encoding="utf-8")
    assert "COPY --chown=tessa:tessa probes/ /app/probes/" in dockerfile
    assert "!probes" in ignore.splitlines()
    assert example_pairs(ENV_EXAMPLE_PATH)["TESSA_PROBES_DIR"] == "../probes"
