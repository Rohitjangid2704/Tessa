from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError

from tessa_api.settings import Settings
from tests.support import ENV_EXAMPLE_PATH, ENV_TEST_PATH

STRONG_API_JWT_SECRET = "prod-api-jwt-secret-0123456789abcdefghij"
STRONG_SERVICE_KEY = "prod-service-key-0123456789abcdefghijkl"
STRONG_SIGNING_KEY = "prod-signing-key-0123456789abcdefghijklm"
STRONG_VAULT_KEY = Fernet.generate_key().decode()
STRONG_DATABASE_URL = "postgresql+asyncpg://tessa:prod-password@db.internal:5432/tessa"


def example_text() -> str:
    return ENV_EXAMPLE_PATH.read_text(encoding="utf-8")


def write_env(tmp_path: Path, extra_lines: str = "", replace: dict[str, str] | None = None) -> Path:
    lines = []
    replacements = replace or {}
    for line in example_text().splitlines():
        key = line.partition("=")[0]
        lines.append(f"{key}={replacements[key]}" if key in replacements else line)
    path = tmp_path / ".env"
    path.write_text("\n".join(lines) + "\n" + extra_lines, encoding="utf-8")
    return path


def production_overrides() -> dict[str, str]:
    return {
        "TESSA_ENV": "prod",
        "TESSA_DATABASE_URL": STRONG_DATABASE_URL,
        "TESSA_API_JWT_SECRET": STRONG_API_JWT_SECRET,
        "TESSA_SERVICE_KEY": STRONG_SERVICE_KEY,
        "TESSA_SIGNING_KEY": STRONG_SIGNING_KEY,
        "TESSA_VAULT_KEY": STRONG_VAULT_KEY,
        "TESSA_BOOTSTRAP_ADMIN_PASSWORD": "prod-admin-password-1",
    }


def test_env_example_is_complete_and_valid() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.env == "dev"
    assert loaded.cors_origins == ["http://localhost:3000", "http://127.0.0.1:3000"]
    assert loaded.public_api_url == "http://localhost:8000"
    assert loaded.bootstrap_admin_email == "admin@tessa.local"


def test_env_test_is_valid() -> None:
    loaded = Settings(_env_file=ENV_TEST_PATH)
    assert loaded.env == "test"
    database_name = loaded.database_url.get_secret_value().rsplit("/", 1)[-1]
    assert "test" in database_name


def test_every_example_key_is_a_settings_field() -> None:
    keys = [line.partition("=")[0] for line in example_text().splitlines() if line]
    fields = {f"TESSA_{name}".upper() for name in Settings.model_fields}
    assert set(keys) == fields
    assert len(keys) == 82


def test_unknown_dotenv_key_is_rejected(tmp_path: Path) -> None:
    path = write_env(tmp_path, "TESSA_NOT_A_REAL_KEY=1\n")
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "tessa_not_a_real_key" in str(caught.value).lower()


def test_unknown_process_variable_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESSA_STALE_EXPORT", "1")
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=ENV_EXAMPLE_PATH)
    assert "TESSA_STALE_EXPORT" in str(caught.value)


def test_unrelated_process_variables_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOMETHING_ELSE", "1")
    assert Settings(_env_file=ENV_EXAMPLE_PATH).env == "dev"


def test_process_variable_overrides_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESSA_LOG_LEVEL", "debug")
    assert Settings(_env_file=ENV_EXAMPLE_PATH).log_level == "debug"


def test_missing_key_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text(
        "\n".join(
            line for line in example_text().splitlines() if not line.startswith("TESSA_ENV=")
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "env" in str(caught.value)


def test_short_secret_is_rejected(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_API_JWT_SECRET": "dev-only-too-short"})
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "api_jwt_secret must be at least 32 bytes" in str(caught.value)


def test_secret_values_are_never_in_the_error(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_API_JWT_SECRET": "dev-only-too-short"})
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "dev-only-too-short" not in str(caught.value)


def test_secrets_must_differ(tmp_path: Path) -> None:
    path = write_env(
        tmp_path,
        replace={"TESSA_SIGNING_KEY": "dev-only-api-jwt-secret-0123456789abcdef"},
    )
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "api_jwt_secret and signing_key must differ" in str(caught.value)


def test_prod_rejects_dev_only_placeholders(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_ENV": "prod"})
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    message = str(caught.value)
    assert "api_jwt_secret still holds a dev-only- placeholder in prod" in message
    assert "service_key still holds a dev-only- placeholder in prod" in message
    assert "signing_key still holds a dev-only- placeholder in prod" in message
    assert "vault_key still holds a dev-only- placeholder in prod" in message
    assert "bootstrap_admin_password still holds a dev-only- placeholder in prod" in message
    assert "database_url password still holds a dev-only- placeholder" in message


def test_prod_accepts_real_values(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace=production_overrides())
    assert Settings(_env_file=path).env == "prod"


def test_dev_accepts_dev_only_placeholders() -> None:
    assert Settings(_env_file=ENV_EXAMPLE_PATH).env == "dev"


def test_bootstrap_admin_is_all_or_nothing(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_BOOTSTRAP_ADMIN_PASSWORD": ""})
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "set together or not at all" in str(caught.value)


def test_cors_origin_with_path_is_rejected(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_CORS_ORIGINS": "http://localhost:3000/app"})
    with pytest.raises(ValidationError):
        Settings(_env_file=path)


def test_public_url_trailing_slash_is_stripped(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_PUBLIC_API_URL": "https://api.example.com/"})
    assert Settings(_env_file=path).public_api_url == "https://api.example.com"


def test_secrets_are_masked_in_repr() -> None:
    rendered = repr(Settings(_env_file=ENV_EXAMPLE_PATH))
    assert "dev-only-api-jwt-secret" not in rendered
    assert "dev-only-service-key" not in rendered
    assert "dev-only-vault-key" not in rendered


def test_dev_vault_key_is_a_valid_fernet_key_with_the_dev_prefix() -> None:
    value = Settings(_env_file=ENV_EXAMPLE_PATH).vault_key.get_secret_value()
    assert value.startswith("dev-only-")
    assert len(value) == 44
    Fernet(value.encode())


def test_vault_key_must_be_a_fernet_key(tmp_path: Path) -> None:
    not_fernet = "dev-only-not-a-fernet-key-0123456789abcdef"
    path = write_env(tmp_path, replace={"TESSA_VAULT_KEY": not_fernet})
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "vault_key must be a urlsafe base64 Fernet key of 32 bytes" in str(caught.value)
    assert not_fernet not in str(caught.value)


def test_vault_key_must_differ_from_the_other_keys(tmp_path: Path) -> None:
    path = write_env(
        tmp_path, replace={"TESSA_SERVICE_KEY": "dev-only-vault-key-0123456789abcdefghijklmA="}
    )
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "service_key and vault_key must differ" in str(caught.value)


def test_data_dir_is_resolved_to_an_absolute_path() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.data_dir.is_absolute()
    assert loaded.data_dir.name == "data"


def test_completeness_bar_is_a_percentage(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_BUNDLE_COMPLETENESS_BAR": "101"})
    with pytest.raises(ValidationError):
        Settings(_env_file=path)


def test_bundle_limits_must_be_positive(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_BUNDLE_MAX_FILES": "0"})
    with pytest.raises(ValidationError):
        Settings(_env_file=path)


def test_stage_two_values_load_from_the_example() -> None:
    loaded = Settings(_env_file=ENV_EXAMPLE_PATH)
    assert loaded.media_url_ttl_seconds == 900
    assert loaded.plan_max_k == 10
    assert loaded.run_default_max_usd == 5.0
    assert loaded.run_default_max_minutes == 30
    assert loaded.run_max_concurrency == 4
    assert loaded.artifact_retention_days == 30
    assert loaded.live_grid_max_fps == 4
    assert loaded.live_focus_max_width == 1280


def test_production_url_patterns_are_a_comma_separated_list_of_regexes(tmp_path: Path) -> None:
    path = write_env(
        tmp_path,
        replace={
            "TESSA_PRODUCTION_URL_PATTERNS": r"^https://app\.example\.com, ^https://api\."
        },
    )
    assert Settings(_env_file=path).production_url_patterns == [
        r"^https://app\.example\.com",
        r"^https://api\.",
    ]


def test_production_url_patterns_may_be_empty(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_PRODUCTION_URL_PATTERNS": ""})
    assert Settings(_env_file=path).production_url_patterns == []


def test_a_production_url_pattern_must_compile(tmp_path: Path) -> None:
    path = write_env(tmp_path, replace={"TESSA_PRODUCTION_URL_PATTERNS": "^https://(unclosed"})
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=path)
    assert "is not a valid regex" in str(caught.value)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("TESSA_PLAN_MAX_K", "0"),
        ("TESSA_PLAN_MAX_K", "11"),
        ("TESSA_RUN_DEFAULT_MAX_USD", "0"),
        ("TESSA_RUN_DEFAULT_MAX_MINUTES", "0"),
        ("TESSA_RUN_MAX_CONCURRENCY", "0"),
        ("TESSA_MEDIA_URL_TTL_SECONDS", "0"),
        ("TESSA_ARTIFACT_RETENTION_DAYS", "0"),
        ("TESSA_LIVE_GRID_QUALITY", "101"),
    ],
)
def test_stage_two_limits_must_be_sensible(tmp_path: Path, key: str, value: str) -> None:
    path = write_env(tmp_path, replace={key: value})
    with pytest.raises(ValidationError):
        Settings(_env_file=path)
