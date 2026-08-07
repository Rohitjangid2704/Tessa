import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from enum import Enum
from typing import Annotated, Any
from urllib.parse import urlparse
from uuid import UUID

import httpx
from pydantic import BaseModel, Field, SecretStr, TypeAdapter, ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio.service import RPCError

from tessa_api.db.models import AppSetting
from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail, Probability
from tessa_api.schemas.enums import (
    Effort,
    ModelRole,
    SecretName,
    ServiceName,
    SettingSource,
)
from tessa_api.schemas.grading import ModelCallSpec
from tessa_api.schemas.runs import ModelSnapshot
from tessa_api.schemas.settings import (
    BudgetSettings,
    EndpointSettings,
    ModelId,
    ModelSettings,
    NotificationSettings,
    PolicySettings,
    PositiveInt,
    SecretStatus,
    ServiceTestResult,
    SettingsPatch,
    SettingsRead,
    ThresholdSettings,
)
from tessa_api.schemas.temporal import JUDGE_MAX_ATTEMPTS
from tessa_api.services.channel_delivery import ChannelDeliveryError, post_slack
from tessa_api.services.health import probe_temporal
from tessa_api.services.probe_bank import load_probe_bank
from tessa_api.services.vault import Vault, VaultError
from tessa_api.settings import HttpUrl, Settings, StrictSettings

logger = logging.getLogger("tessa_api.settings")

PATH_SEPARATOR = "."
MODEL_MAX_INPUT_TOKENS = 6000
MODEL_CALL_MAX_ATTEMPTS = JUDGE_MAX_ATTEMPTS
STUB_MODEL_NAME = "stub"
SERVICE_TEST_TIMEOUT_SECONDS = 8.0
NOT_CONFIGURED_MESSAGE = "not configured"
SLACK_TEST_TEXT = "Tessa test message: this Slack webhook is working."
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
ANTHROPIC_VERSION = "2023-06-01"
LAYA_SYSTEMONE_PATH = "/v1/systemone"
LAYA_PING_QUESTION_ID = "ping"
LAYA_PING_BODY: dict[str, Any] = {
    "state": "ok",
    "questions": {
        LAYA_PING_QUESTION_ID: {"type": "noul", "instructions": "Is this a greeting?"},
    },
}
SLACK_ENABLED_PATH = "notifications.slack_enabled"

SECRET_ENV_FIELDS: Mapping[SecretName, str] = {
    SecretName.openai_api_key: "openai_api_key",
    SecretName.anthropic_api_key: "anthropic_api_key",
    SecretName.slack_webhook_url: "slack_webhook_url",
}

THRESHOLD_FIELDS: Mapping[str, str] = {
    "thresholds.probe_confidence": "probe_confidence_threshold",
    "thresholds.judge_escalate_below": "judge_escalate_below",
    "thresholds.label_audit_rate": "label_audit_rate",
}
ENDPOINT_FIELDS: Mapping[str, str] = {
    "endpoints.laya_url": "laya_url",
}
BUDGET_FIELDS: Mapping[str, str] = {
    "budgets.default_max_usd": "run_default_max_usd",
    "budgets.default_max_minutes": "run_default_max_minutes",
    "budgets.max_concurrency": "run_max_concurrency",
}
POLICY_FIELDS: Mapping[str, str] = {
    "policies.flaky_quarantine_after": "flaky_quarantine_after",
}
MODEL_LEAVES = ("model", "effort", "max_usd", "timeout_seconds")

NonNegativeFloat = Annotated[float, Field(ge=0)]
PositiveFloat = Annotated[float, Field(gt=0)]


def model_leaf_path(role: ModelRole, leaf: str) -> str:
    return PATH_SEPARATOR.join(("models", role.value, leaf))


def build_leaf_fields() -> dict[str, str]:
    fields = {**THRESHOLD_FIELDS, **ENDPOINT_FIELDS, **BUDGET_FIELDS, **POLICY_FIELDS}
    for role in ModelRole:
        for leaf in MODEL_LEAVES:
            fields[model_leaf_path(role, leaf)] = f"{leaf}_{role.value}"
    return fields


def build_leaf_adapters() -> dict[str, TypeAdapter[Any]]:
    adapters: dict[str, TypeAdapter[Any]] = {
        "thresholds.probe_confidence": TypeAdapter(Probability),
        "thresholds.judge_escalate_below": TypeAdapter(Probability),
        "thresholds.label_audit_rate": TypeAdapter(Probability),
        "endpoints.laya_url": TypeAdapter(HttpUrl),
        "budgets.default_max_usd": TypeAdapter(PositiveFloat),
        "budgets.default_max_minutes": TypeAdapter(PositiveInt),
        "budgets.max_concurrency": TypeAdapter(PositiveInt),
        "policies.flaky_quarantine_after": TypeAdapter(PositiveInt),
        SLACK_ENABLED_PATH: TypeAdapter(bool),
    }
    for role in ModelRole:
        adapters[model_leaf_path(role, "model")] = TypeAdapter(ModelId)
        adapters[model_leaf_path(role, "effort")] = TypeAdapter(Effort)
        adapters[model_leaf_path(role, "max_usd")] = TypeAdapter(NonNegativeFloat)
        adapters[model_leaf_path(role, "timeout_seconds")] = TypeAdapter(PositiveInt)
    return adapters


LEAF_FIELDS = build_leaf_fields()
LEAF_ADAPTERS = build_leaf_adapters()


class ResolvedRunModels(BaseModel):
    specs: dict[ModelRole, ModelCallSpec]
    models: dict[ModelRole, ModelSnapshot]
    probe_bank_version: str


class ServiceTestFailure(Exception):
    pass


def storable(value: Any) -> Any:
    return value.value if isinstance(value, Enum) else value


async def load_overrides(session: AsyncSession) -> dict[str, Any]:
    rows = await session.execute(
        select(AppSetting.key, AppSetting.value).where(
            AppSetting.is_secret.is_(False), AppSetting.key.in_(list(LEAF_ADAPTERS))
        )
    )
    overrides: dict[str, Any] = {}
    for key, value in rows:
        adapter = LEAF_ADAPTERS.get(key)
        if adapter is None or value is None:
            continue
        try:
            overrides[key] = adapter.validate_python(value)
        except ValidationError:
            logger.warning("setting_override_ignored", extra={"key": key})
    return overrides


def apply_overrides[S: StrictSettings](settings: S, overrides: Mapping[str, Any]) -> S:
    known = type(settings).model_fields
    updates = {
        LEAF_FIELDS[path]: value
        for path, value in overrides.items()
        if path in LEAF_FIELDS and LEAF_FIELDS[path] in known
    }
    return settings.model_copy(update=updates) if updates else settings


async def effective_settings[S: StrictSettings](session: AsyncSession, settings: S) -> S:
    return apply_overrides(settings, await load_overrides(session))


def invalid_leaf_error(path: str, error: ValidationError) -> ApiError:
    location: list[str | int] = ["body", *path.split(PATH_SEPARATOR)]
    details = [
        ErrorDetail(loc=[*location, *item["loc"]], code=str(item["type"]), message=str(item["msg"]))
        for item in error.errors()
    ]
    return ApiError(422, "validation_failed", "Request validation failed", details)


def group_leaves(prefix: str, group: BaseModel) -> dict[str, Any]:
    return {
        f"{prefix}{PATH_SEPARATOR}{field}": getattr(group, field)
        for field in group.model_fields_set
    }


def patched_leaves(patch: SettingsPatch) -> dict[str, Any]:
    leaves: dict[str, Any] = {}
    for role, role_patch in (patch.models or {}).items():
        leaves.update(group_leaves(f"models{PATH_SEPARATOR}{role.value}", role_patch))
    for name in ("thresholds", "endpoints", "budgets", "notifications", "policies"):
        group = getattr(patch, name)
        if group is not None:
            leaves.update(group_leaves(name, group))
    return leaves


def validated_leaf(path: str, value: Any) -> Any:
    if value is None:
        return None
    try:
        validated = LEAF_ADAPTERS[path].validate_python(value)
    except ValidationError as error:
        raise invalid_leaf_error(path, error) from None
    return storable(validated)


def upsert_setting(key: str, value: Any, user_id: UUID | None) -> Any:
    statement = insert(AppSetting).values(
        key=key, value=value, is_secret=False, encrypted_value=None, updated_by=user_id
    )
    return statement.on_conflict_do_update(
        index_elements=[AppSetting.key],
        set_={
            "value": statement.excluded.value,
            "is_secret": False,
            "encrypted_value": None,
            "updated_at": func.now(),
            "updated_by": statement.excluded.updated_by,
        },
    )


async def apply_settings_patch(session: AsyncSession, user_id: UUID, patch: SettingsPatch) -> None:
    leaves = {path: validated_leaf(path, value) for path, value in patched_leaves(patch).items()}
    removed = [path for path, value in leaves.items() if value is None]
    if removed:
        await session.execute(
            delete(AppSetting).where(AppSetting.key.in_(removed), AppSetting.is_secret.is_(False))
        )
    for path, value in leaves.items():
        if value is not None:
            await session.execute(upsert_setting(path, value, user_id))


def model_source(role: ModelRole, overrides: Mapping[str, Any]) -> SettingSource:
    held = any(model_leaf_path(role, leaf) in overrides for leaf in MODEL_LEAVES)
    return SettingSource.db if held else SettingSource.env


def model_settings_read(
    role: ModelRole, effective: StrictSettings, overrides: Mapping[str, Any]
) -> ModelSettings:
    defaults = effective.role_defaults(role)
    return ModelSettings(
        model=defaults.model,
        effort=defaults.effort,
        max_usd=defaults.max_usd,
        timeout_seconds=defaults.timeout_seconds,
        source=model_source(role, overrides),
    )


def secret_env_value(settings: StrictSettings, name: SecretName) -> str | None:
    field = SECRET_ENV_FIELDS.get(name)
    return None if field is None else settings.optional_secret(field)


async def stored_secret_rows(session: AsyncSession) -> dict[SecretName, AppSetting]:
    rows = await session.scalars(
        select(AppSetting).where(
            AppSetting.key.in_([name.value for name in SecretName]),
            AppSetting.is_secret.is_(True),
            AppSetting.encrypted_value.is_not(None),
        )
    )
    return {SecretName(row.key): row for row in rows}


def secret_status(
    name: SecretName, row: AppSetting | None, settings: StrictSettings
) -> SecretStatus:
    if row is not None:
        return SecretStatus(
            name=name,
            has_value=True,
            last_set_at=row.updated_at,
            last_set_by=row.updated_by,
            source=SettingSource.db,
        )
    from_env = secret_env_value(settings, name) is not None
    return SecretStatus(
        name=name,
        has_value=from_env,
        last_set_at=None,
        last_set_by=None,
        source=SettingSource.env if from_env else None,
    )


async def read_settings(session: AsyncSession, settings: Settings) -> SettingsRead:
    overrides = await load_overrides(session)
    effective = apply_overrides(settings, overrides)
    rows = await stored_secret_rows(session)
    secrets = {name: secret_status(name, rows.get(name), settings) for name in SecretName}
    return SettingsRead(
        models={role: model_settings_read(role, effective, overrides) for role in ModelRole},
        thresholds=ThresholdSettings(
            probe_confidence=effective.probe_confidence_threshold,
            judge_escalate_below=effective.judge_escalate_below,
            label_audit_rate=effective.label_audit_rate,
        ),
        endpoints=EndpointSettings(laya_url=effective.laya_url),
        budgets=BudgetSettings(
            default_max_usd=effective.run_default_max_usd,
            default_max_minutes=effective.run_default_max_minutes,
            max_concurrency=effective.run_max_concurrency,
        ),
        notifications=NotificationSettings(
            slack_enabled=overrides.get(
                SLACK_ENABLED_PATH, secrets[SecretName.slack_webhook_url].has_value
            ),
        ),
        policies=PolicySettings(flaky_quarantine_after=effective.flaky_quarantine_after),
        overrides=sorted(overrides),
        secrets=secrets,
    )


def slack_webhook_error() -> ApiError:
    detail = ErrorDetail(loc=["body", "value"], code="invalid_url", message="must be an https URL")
    return ApiError(422, "validation_failed", "Request validation failed", [detail])


def check_secret_value(name: SecretName, value: SecretStr) -> None:
    if name is not SecretName.slack_webhook_url:
        return
    parsed = urlparse(value.get_secret_value())
    if parsed.scheme != "https" or not parsed.netloc:
        raise slack_webhook_error()


async def store_secret(
    session: AsyncSession, vault: Vault, user_id: UUID, name: SecretName, value: SecretStr
) -> SecretStatus:
    check_secret_value(name, value)
    encrypted = vault.encrypt(value.get_secret_value())
    statement = insert(AppSetting).values(
        key=name.value, value=None, is_secret=True, encrypted_value=encrypted, updated_by=user_id
    )
    upsert = statement.on_conflict_do_update(
        index_elements=[AppSetting.key],
        set_={
            "value": None,
            "is_secret": True,
            "encrypted_value": statement.excluded.encrypted_value,
            "updated_at": func.now(),
            "updated_by": statement.excluded.updated_by,
        },
    ).returning(AppSetting.updated_at)
    updated_at = (await session.execute(upsert)).scalar_one()
    return SecretStatus(
        name=name,
        has_value=True,
        last_set_at=updated_at,
        last_set_by=user_id,
        source=SettingSource.db,
    )


async def clear_secret(session: AsyncSession, name: SecretName) -> bool:
    cleared = await session.execute(
        delete(AppSetting)
        .where(AppSetting.key == name.value, AppSetting.is_secret.is_(True))
        .returning(AppSetting.key)
    )
    return cleared.scalar_one_or_none() is not None


async def resolve_secret(
    session: AsyncSession, vault: Vault, settings: StrictSettings, name: SecretName
) -> SecretStr | None:
    encrypted = await session.scalar(
        select(AppSetting.encrypted_value).where(
            AppSetting.key == name.value, AppSetting.is_secret.is_(True)
        )
    )
    if encrypted is not None:
        return vault.decrypt(encrypted)
    from_env = secret_env_value(settings, name)
    return None if from_env is None else SecretStr(from_env)


async def resolve_thresholds(session: AsyncSession, settings: StrictSettings) -> ThresholdSettings:
    effective = await effective_settings(session, settings)
    return ThresholdSettings(
        probe_confidence=effective.probe_confidence_threshold,
        judge_escalate_below=effective.judge_escalate_below,
        label_audit_rate=effective.label_audit_rate,
    )


def model_call_spec(role: ModelRole, effective: StrictSettings) -> ModelCallSpec:
    defaults = effective.role_defaults(role)
    return ModelCallSpec(
        role=role,
        model=STUB_MODEL_NAME if effective.stub_models else defaults.model,
        effort=defaults.effort,
        max_usd=defaults.max_usd,
        max_input_tokens=MODEL_MAX_INPUT_TOKENS,
        max_output_tokens=defaults.max_output_tokens,
        start_to_close_timeout_seconds=defaults.timeout_seconds,
        max_attempts=MODEL_CALL_MAX_ATTEMPTS,
    )


async def resolve_model_specs(session: AsyncSession, settings: StrictSettings) -> ResolvedRunModels:
    effective = await effective_settings(session, settings)
    specs = {role: model_call_spec(role, effective) for role in ModelRole}
    return ResolvedRunModels(
        specs=specs,
        models={
            role: ModelSnapshot(model=spec.model, effort=spec.effort)
            for role, spec in specs.items()
        },
        probe_bank_version=load_probe_bank(effective.probes_dir).version,
    )


def not_configured(service: ServiceName) -> ServiceTestResult:
    return ServiceTestResult(
        service=service, ok=False, latency_ms=None, message=NOT_CONFIGURED_MESSAGE
    )


def service_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=SERVICE_TEST_TIMEOUT_SECONDS, follow_redirects=False)


def expect_success(response: httpx.Response) -> None:
    if not response.is_success:
        raise ServiceTestFailure(f"HTTP {response.status_code}")


def laya_ping_answered(response: httpx.Response) -> bool:
    try:
        noul = response.json()["answers"][LAYA_PING_QUESTION_ID]["noul"]
    except (ValueError, KeyError, TypeError):
        return False
    return isinstance(noul, int | float) and not isinstance(noul, bool) and 0 <= noul <= 1


async def ping_laya(url: str) -> str:
    async with service_client() as client:
        response = await client.post(f"{url}{LAYA_SYSTEMONE_PATH}", json=LAYA_PING_BODY)
    expect_success(response)
    if not laya_ping_answered(response):
        raise ServiceTestFailure("unexpected answer")
    return "answered"


async def ping_openai(key: SecretStr) -> str:
    headers = {"Authorization": f"Bearer {key.get_secret_value()}"}
    async with service_client() as client:
        response = await client.get(OPENAI_MODELS_URL, headers=headers)
    expect_success(response)
    return "key accepted"


async def ping_anthropic(key: SecretStr) -> str:
    headers = {"x-api-key": key.get_secret_value(), "anthropic-version": ANTHROPIC_VERSION}
    async with service_client() as client:
        response = await client.get(ANTHROPIC_MODELS_URL, headers=headers)
    expect_success(response)
    return "key accepted"


async def ping_temporal(address: str) -> str:
    try:
        await probe_temporal(address)
    except (RuntimeError, OSError, RPCError):
        raise ServiceTestFailure("unreachable") from None
    return "serving"


async def post_slack_test(webhook: SecretStr) -> str:
    async with service_client() as client:
        try:
            await post_slack(
                client, webhook, SLACK_TEST_TEXT, timeout_seconds=SERVICE_TEST_TIMEOUT_SECONDS
            )
        except ChannelDeliveryError as error:
            raise ServiceTestFailure(error.message) from None
    return "message posted"


async def slack_test(
    session: AsyncSession, vault: Vault, settings: StrictSettings
) -> ServiceTestResult:
    try:
        webhook = await resolve_secret(session, vault, settings, SecretName.slack_webhook_url)
    except VaultError:
        return ServiceTestResult(
            service=ServiceName.slack,
            ok=False,
            latency_ms=None,
            message="the stored webhook cannot be decrypted",
        )
    if webhook is None:
        return not_configured(ServiceName.slack)
    return await timed_service_call(ServiceName.slack, lambda: post_slack_test(webhook))


async def timed_service_call(
    service: ServiceName, call: Callable[[], Awaitable[str]]
) -> ServiceTestResult:
    started = time.perf_counter()
    ok = False
    try:
        async with asyncio.timeout(SERVICE_TEST_TIMEOUT_SECONDS + 1):
            message = await call()
        ok = True
    except TimeoutError:
        message = f"timed out after {SERVICE_TEST_TIMEOUT_SECONDS:g}s"
    except ServiceTestFailure as failure:
        message = str(failure)
    except httpx.HTTPError as error:
        message = type(error).__name__
    except VaultError:
        message = "the stored key cannot be decrypted"
    except Exception as error:
        message = f"failed: {type(error).__name__}"
    return ServiceTestResult(
        service=service,
        ok=ok,
        latency_ms=round((time.perf_counter() - started) * 1000),
        message=message,
    )


async def run_service_test(
    session: AsyncSession,
    vault: Vault,
    settings: Settings,
    service: ServiceName,
) -> ServiceTestResult:
    effective = await effective_settings(session, settings)
    match service:
        case ServiceName.slack:
            return await slack_test(session, vault, settings)
        case ServiceName.temporal:
            return await timed_service_call(
                service, lambda: ping_temporal(effective.temporal_address)
            )
        case ServiceName.laya:
            if not effective.laya_url:
                return not_configured(service)
            return await timed_service_call(service, lambda: ping_laya(effective.laya_url))
        case ServiceName.openai:
            return await provider_test(
                session, vault, settings, service, SecretName.openai_api_key, ping_openai
            )
        case ServiceName.anthropic:
            return await provider_test(
                session, vault, settings, service, SecretName.anthropic_api_key, ping_anthropic
            )


async def provider_test(
    session: AsyncSession,
    vault: Vault,
    settings: StrictSettings,
    service: ServiceName,
    secret: SecretName,
    ping: Callable[[SecretStr], Awaitable[str]],
) -> ServiceTestResult:
    try:
        key = await resolve_secret(session, vault, settings, secret)
    except VaultError:
        return ServiceTestResult(
            service=service,
            ok=False,
            latency_ms=None,
            message="the stored key cannot be decrypted",
        )
    if key is None:
        return not_configured(service)
    return await timed_service_call(service, lambda: ping(key))
