import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, ClassVar, Literal, Self
from urllib.parse import urlparse

from cryptography.fernet import Fernet
from pydantic import AfterValidator, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import make_url

from tessa_api.schemas.common import EMBEDDING_DIMENSIONS, Probability
from tessa_api.schemas.enums import Effort, ModelRole

ENV_PREFIX = "TESSA_"
DEV_ONLY_PREFIX = "dev-only-"
MIN_SECRET_BYTES = 32


def normalize_http_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("must be an http or https URL")
    return value.rstrip("/")


def normalize_optional_http_url(value: str) -> str:
    if value == "":
        return value
    return normalize_http_url(value)


def is_https_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def normalize_origin(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"origin {value!r} must look like http://host:port")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError(f"origin {value!r} must not carry a path, query or fragment")
    return f"{parsed.scheme}://{parsed.netloc}"


def is_fernet_key(value: str) -> bool:
    try:
        Fernet(value.encode())
    except (ValueError, TypeError):
        return False
    return True


HttpUrl = Annotated[str, AfterValidator(normalize_http_url)]
OptionalHttpUrl = Annotated[str, AfterValidator(normalize_optional_http_url)]
PositiveInt = Annotated[int, Field(gt=0)]
PositiveFloat = Annotated[float, Field(gt=0)]
TcpPort = Annotated[int, Field(ge=1, le=65535)]
ModelId = Annotated[str, Field(min_length=1)]


@dataclass(frozen=True, slots=True)
class ModelRoleDefaults:
    model: str
    effort: Effort
    max_usd: float
    max_output_tokens: int
    timeout_seconds: int


class StrictSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        extra="forbid",
        protected_namespaces=(),
        case_sensitive=False,
        env_file_encoding="utf-8",
    )

    key_secret_fields: ClassVar[tuple[str, ...]] = ()
    distinct_secret_fields: ClassVar[tuple[str, ...]] = ()
    credential_fields: ClassVar[tuple[str, ...]] = ()

    env: Literal["dev", "test", "prod"]
    log_level: Literal["debug", "info", "warning", "error", "critical"]
    database_url: SecretStr
    temporal_address: str = Field(min_length=1)
    temporal_namespace: str = Field(min_length=1)
    temporal_task_queue: str = Field(min_length=1)
    service_key: SecretStr
    vault_key: SecretStr
    data_dir: Path
    run_max_concurrency: PositiveInt
    artifact_retention_days: PositiveInt
    live_grid_max_fps: PositiveInt
    live_grid_quality: Annotated[int, Field(ge=1, le=100)]
    live_grid_max_width: PositiveInt
    live_focus_max_fps: PositiveInt
    live_focus_quality: Annotated[int, Field(ge=1, le=100)]
    live_focus_max_width: PositiveInt
    oracle_max_rows: PositiveInt
    openai_api_key: SecretStr
    anthropic_api_key: SecretStr
    probes_dir: Path
    probe_confidence_threshold: Probability
    judge_escalate_below: Probability
    label_audit_rate: Probability
    stub_models: bool
    embedding_model: ModelId
    embedding_dimensions: PositiveInt
    metrics_enabled: bool
    model_judge: ModelId
    effort_judge: Effort
    max_usd_judge: PositiveFloat
    max_output_tokens_judge: PositiveInt
    timeout_seconds_judge: PositiveInt
    model_judge_tiebreak: ModelId
    effort_judge_tiebreak: Effort
    max_usd_judge_tiebreak: PositiveFloat
    max_output_tokens_judge_tiebreak: PositiveInt
    timeout_seconds_judge_tiebreak: PositiveInt
    slack_webhook_url: SecretStr
    report_base_url: HttpUrl
    flaky_quarantine_after: PositiveInt
    retention_steps_days: PositiveInt
    retention_run_events_days: PositiveInt

    @field_validator("data_dir", "probes_dir")
    @classmethod
    def resolve_directory(cls, value: Path) -> Path:
        return value.expanduser().resolve()

    @model_validator(mode="before")
    @classmethod
    def reject_unknown_process_variables(cls, data: Any) -> Any:
        known = {f"{ENV_PREFIX}{name}".upper() for name in cls.model_fields}
        unknown = sorted(
            name
            for name in os.environ
            if name.upper().startswith(ENV_PREFIX) and name.upper() not in known
        )
        if unknown:
            raise ValueError(
                f"unknown {ENV_PREFIX}* environment variables for {cls.__name__}: "
                f"{', '.join(unknown)}"
            )
        return data

    @model_validator(mode="after")
    def validate_secrets(self) -> Self:
        problems: list[str] = []
        key_values: dict[str, str] = {}
        for name in self.key_secret_fields:
            value = self.secret_value(name)
            key_values[name] = value
            if len(value.encode()) < MIN_SECRET_BYTES:
                problems.append(f"{name} must be at least {MIN_SECRET_BYTES} bytes")
        if not is_fernet_key(self.vault_key.get_secret_value()):
            problems.append("vault_key must be a urlsafe base64 Fernet key of 32 bytes")
        names = list(self.distinct_secret_fields)
        for index, first in enumerate(names):
            for second in names[index + 1 :]:
                if key_values.get(first) == key_values.get(second):
                    problems.append(f"{first} and {second} must differ")
        if self.env == "prod":
            for name in (*self.key_secret_fields, *self.credential_fields):
                if self.secret_value(name).startswith(DEV_ONLY_PREFIX):
                    problems.append(f"{name} still holds a {DEV_ONLY_PREFIX} placeholder in prod")
            password = make_url(self.database_url.get_secret_value()).password or ""
            if password.startswith(DEV_ONLY_PREFIX):
                problems.append(
                    f"database_url password still holds a {DEV_ONLY_PREFIX} placeholder"
                )
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @model_validator(mode="after")
    def refuse_stub_models_in_prod(self) -> Self:
        if self.env == "prod" and self.stub_models:
            raise ValueError("stub_models must be false when env is prod")
        return self

    @model_validator(mode="after")
    def validate_notification_channels(self) -> Self:
        problems: list[str] = []
        webhook = self.slack_webhook_url.get_secret_value()
        if webhook and not is_https_url(webhook):
            problems.append("slack_webhook_url must be an https URL")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @model_validator(mode="after")
    def require_embedding_dimensions_of_the_vector_columns(self) -> Self:
        if self.embedding_dimensions != EMBEDDING_DIMENSIONS:
            raise ValueError(
                f"embedding_dimensions must equal the vector columns ({EMBEDDING_DIMENSIONS})"
            )
        return self

    def secret_value(self, name: str) -> str:
        value = getattr(self, name)
        if not isinstance(value, SecretStr):
            raise TypeError(f"{name} is not a secret field")
        return value.get_secret_value()

    def optional_secret(self, name: str) -> str | None:
        return self.secret_value(name) or None

    def role_defaults(self, role: ModelRole) -> ModelRoleDefaults:
        suffix = role.value
        model: str = getattr(self, f"model_{suffix}")
        effort: Effort = getattr(self, f"effort_{suffix}")
        max_usd: float = getattr(self, f"max_usd_{suffix}")
        max_output_tokens: int = getattr(self, f"max_output_tokens_{suffix}")
        timeout_seconds: int = getattr(self, f"timeout_seconds_{suffix}")
        return ModelRoleDefaults(model, effort, max_usd, max_output_tokens, timeout_seconds)


class Settings(StrictSettings):
    model_config = SettingsConfigDict(env_file=".env")

    key_secret_fields: ClassVar[tuple[str, ...]] = (
        "api_jwt_secret",
        "signing_key",
        "service_key",
        "vault_key",
    )
    distinct_secret_fields: ClassVar[tuple[str, ...]] = (
        "api_jwt_secret",
        "signing_key",
        "service_key",
        "vault_key",
    )
    credential_fields: ClassVar[tuple[str, ...]] = ("bootstrap_admin_password",)

    temporal_ui_url: HttpUrl
    public_api_url: HttpUrl
    cors_origins: Annotated[list[str], NoDecode]
    docs_enabled: bool
    api_jwt_secret: SecretStr
    api_jwt_issuer: str = Field(min_length=1)
    api_jwt_audience: str = Field(min_length=1)
    signing_key: SecretStr
    ws_ticket_ttl_seconds: PositiveInt
    stream_heartbeat_seconds: PositiveInt
    stream_max_age_seconds: PositiveInt
    stream_replay_max_events: PositiveInt
    ws_max_connections_per_user: PositiveInt
    ws_send_queue_max: PositiveInt
    live_max_tiles_per_client: PositiveInt
    schemas_dir: Path
    bootstrap_admin_email: str
    bootstrap_admin_password: SecretStr
    idempotency_ttl_hours: PositiveInt
    laya_url: OptionalHttpUrl
    bundle_max_zip_bytes: PositiveInt
    bundle_max_uncompressed_bytes: PositiveInt
    bundle_max_files: PositiveInt
    bundle_max_file_bytes: PositiveInt
    bundle_max_manifest_bytes: PositiveInt
    bundle_completeness_bar: Annotated[int, Field(ge=0, le=100)]
    health_check_timeout_seconds: PositiveInt
    health_check_concurrency: PositiveInt
    media_url_ttl_seconds: PositiveInt
    plan_max_k: Annotated[int, Field(ge=1, le=10)]
    run_default_max_usd: Annotated[float, Field(gt=0)]
    run_default_max_minutes: PositiveInt
    production_url_patterns: Annotated[list[str], NoDecode]
    explain_max_chars: PositiveInt
    explanation_max_chars: PositiveInt
    plan_estimate_cost_per_cell_usd: PositiveFloat
    calibration_min_labels: PositiveInt
    commit_tier_max_minutes: PositiveInt
    personal_token_max_days: Annotated[int, Field(ge=1, le=365)]

    @field_validator("production_url_patterns", mode="before")
    @classmethod
    def split_production_url_patterns(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("production_url_patterns")
    @classmethod
    def require_compilable_patterns(cls, value: list[str]) -> list[str]:
        for pattern in value:
            try:
                re.compile(pattern)
            except re.error as error:
                raise ValueError(f"pattern {pattern!r} is not a valid regex: {error}") from error
        return value

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_cors_origins(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [normalize_origin(part.strip()) for part in value.split(",") if part.strip()]
        return value

    @field_validator("cors_origins")
    @classmethod
    def require_cors_origins(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("at least one origin is required")
        return value

    @model_validator(mode="after")
    def validate_bootstrap_admin(self) -> Self:
        email_set = self.bootstrap_admin_email != ""
        password_set = self.bootstrap_admin_password.get_secret_value() != ""
        if email_set != password_set:
            raise ValueError(
                "bootstrap_admin_email and bootstrap_admin_password are set together or not at all"
            )
        if email_set and "@" not in self.bootstrap_admin_email:
            raise ValueError("bootstrap_admin_email must be an email address")
        return self


def load_settings() -> Settings:
    return Settings()
