from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from tessa_api.schemas.common import Probability, Timestamp
from tessa_api.schemas.enums import (
    Effort,
    ModelRole,
    SecretName,
    ServiceName,
    SettingSource,
)

SECRET_VALUE_MAX_CHARS = 4096

PositiveFloat = Annotated[float, Field(gt=0)]
PositiveInt = Annotated[int, Field(ge=1)]
ModelId = Annotated[str, Field(min_length=1, max_length=200)]
ServiceUrl = Annotated[str, Field(min_length=1, max_length=2048)]


class ModelSettings(BaseModel):
    model: str
    effort: Effort
    max_usd: float = Field(ge=0, description="budget of one call")
    timeout_seconds: int = Field(ge=1)
    source: SettingSource = Field(description="db when any leaf of this role is overridden")


class ThresholdSettings(BaseModel):
    probe_confidence: Probability
    judge_escalate_below: Probability
    label_audit_rate: Probability


class EndpointSettings(BaseModel):
    laya_url: str


class BudgetSettings(BaseModel):
    default_max_usd: float = Field(gt=0)
    default_max_minutes: int = Field(ge=1)
    max_concurrency: int = Field(ge=1)


class NotificationSettings(BaseModel):
    slack_enabled: bool = Field(
        description="false mutes every Slack message; defaults to true once a webhook is set"
    )


class PolicySettings(BaseModel):
    flaky_quarantine_after: int = Field(
        ge=1, description="consecutive flaky runs after which a scenario is quarantined"
    )


class SecretStatus(BaseModel):
    name: SecretName
    has_value: bool
    last_set_at: Timestamp | None
    last_set_by: UUID | None = Field(description="admin who last set the value")
    source: SettingSource | None = Field(description="null when no value is set")


class SettingsRead(BaseModel):
    models: dict[ModelRole, ModelSettings]
    thresholds: ThresholdSettings
    endpoints: EndpointSettings
    budgets: BudgetSettings
    notifications: NotificationSettings | None = Field(
        description="the Slack switch; the webhook is a secret"
    )
    policies: PolicySettings | None = Field(description="rules the harness applies to itself")
    overrides: list[str] = Field(
        description="dotted paths held in the settings row, such as thresholds.probe_confidence"
    )
    secrets: dict[SecretName, SecretStatus]


class SettingsPatchModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelSettingsPatch(SettingsPatchModel):
    model: ModelId | None = None
    effort: Effort | None = None
    max_usd: Annotated[float, Field(ge=0)] | None = None
    timeout_seconds: PositiveInt | None = None


class ThresholdSettingsPatch(SettingsPatchModel):
    probe_confidence: Probability | None = None
    judge_escalate_below: Probability | None = None
    label_audit_rate: Probability | None = None


class EndpointSettingsPatch(SettingsPatchModel):
    laya_url: ServiceUrl | None = None


class BudgetSettingsPatch(SettingsPatchModel):
    default_max_usd: PositiveFloat | None = None
    default_max_minutes: PositiveInt | None = None
    max_concurrency: PositiveInt | None = None


class NotificationSettingsPatch(SettingsPatchModel):
    slack_enabled: bool | None = None


class PolicySettingsPatch(SettingsPatchModel):
    flaky_quarantine_after: PositiveInt | None = None


class SettingsPatch(SettingsPatchModel):
    models: dict[ModelRole, ModelSettingsPatch] | None = None
    thresholds: ThresholdSettingsPatch | None = None
    endpoints: EndpointSettingsPatch | None = None
    budgets: BudgetSettingsPatch | None = None
    notifications: NotificationSettingsPatch | None = None
    policies: PolicySettingsPatch | None = None

    @model_validator(mode="after")
    def groups_are_objects_not_null(self) -> Self:
        nulled = sorted(name for name in self.model_fields_set if getattr(self, name) is None)
        if nulled:
            raise ValueError(
                f"{', '.join(nulled)} cannot be null: null deletes a leaf override, not a group"
            )
        return self


class SecretSet(BaseModel):
    value: SecretStr = Field(
        min_length=1, max_length=SECRET_VALUE_MAX_CHARS, description="secret value, write-only"
    )


class ServiceTestResult(BaseModel):
    service: ServiceName
    ok: bool
    latency_ms: int | None = Field(ge=0, description="round trip of the free call; null if none")
    message: str | None = Field(description="short outcome text; never a key or a URL with secrets")
