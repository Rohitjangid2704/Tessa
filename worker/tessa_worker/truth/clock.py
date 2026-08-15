import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, tzinfo
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest, QaHook
from tessa_api.schemas.enums import AdapterKind, BundleValidationStatus
from tessa_api.schemas.runs import ClockSnapshot
from tessa_api.schemas.scenario import ANONYMOUS_IDENTITY, HttpMethod, HttpStep, RequestSpec
from tessa_api.schemas.steps import HttpStepResponse
from tessa_api.services.vault import Vault
from tessa_worker.adapters.auth import AccessResolver, ResolvedEnvironment, load_environment
from tessa_worker.adapters.base import Adapter, ClockPinning
from tessa_worker.adapters.context import (
    AdapterContext,
    AdapterLimits,
    ResolvedInterface,
    resolve_interface,
)
from tessa_worker.adapters.errors import AdapterError
from tessa_worker.adapters.registry import AdapterRegistry
from tessa_worker.mutation.override import OverrideNotApplicableError, override_environment
from tessa_worker.settings import WorkerSettings

PIN_CLOCK_HOOK_ID = "pin_clock"
HOOK_TIMEOUT_SECONDS = 15.0
HOOK_ENDPOINT_PATTERN = re.compile(r"^(GET|POST|PUT|PATCH)\s+(/\S*)$", re.IGNORECASE)
HOOK_METHODS: dict[str, HttpMethod] = {"GET": "GET", "POST": "POST", "PUT": "PUT", "PATCH": "PATCH"}
IANA_KEY_PATTERN = re.compile(r"[A-Za-z][A-Za-z_+-]*(?:/[A-Za-z][A-Za-z_+-]*)+")
HOOK_LABEL = "pin the target clock"
AT_FIELD = "at"


class ClockPinError(Exception):
    def __init__(self, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class HookEndpoint:
    method: HttpMethod
    path: str


def utc_now() -> datetime:
    moment = datetime.now(UTC)
    return moment.replace(microsecond=moment.microsecond // 1000 * 1000)


def pin_clock_hook(manifest: BundleManifest) -> QaHook | None:
    if manifest.test_hooks is None:
        return None
    return next(
        (hook for hook in manifest.test_hooks.available if hook.id == PIN_CLOCK_HOOK_ID), None
    )


def hook_endpoint(hook: QaHook) -> HookEndpoint:
    matched = HOOK_ENDPOINT_PATTERN.match((hook.endpoint or "").strip())
    if matched is None:
        raise ClockPinError(
            f"the {hook.id} hook declares no endpoint of the form 'METHOD /path' "
            f"({hook.endpoint!r}), so the clock cannot be pinned",
            retryable=False,
        )
    return HookEndpoint(method=HOOK_METHODS[matched.group(1).upper()], path=matched.group(2))


def load_zone(key: str) -> ZoneInfo | None:
    try:
        return ZoneInfo(key)
    except (ValueError, OSError, KeyError):
        return None


def resolve_timezone(description: str | None) -> tzinfo:
    if description:
        stripped = description.strip()
        for candidate in (stripped, *IANA_KEY_PATTERN.findall(stripped)):
            zone = load_zone(candidate)
            if zone is not None:
                return zone
    return UTC


def manifest_timezone(manifest: BundleManifest) -> tzinfo:
    return resolve_timezone(manifest.data_model.timezone if manifest.data_model else None)


def clock_date(clock: ClockSnapshot, zone: tzinfo) -> date:
    return clock.at.astimezone(zone).date()


class HookClockPinner:
    def __init__(self, adapter: Adapter, endpoint: HookEndpoint) -> None:
        self.adapter = adapter
        self.endpoint = endpoint

    async def pin_clock(self, at: datetime) -> None:
        step = HttpStep(
            adapter="http",
            label=HOOK_LABEL,
            request=RequestSpec(
                method=self.endpoint.method,
                path=self.endpoint.path,
                body={AT_FIELD: at.astimezone(UTC).isoformat(timespec="milliseconds")},
            ),
        )
        record = await self.adapter.drive(step)
        response = record.response
        succeeded = (
            record.ok is True
            and isinstance(response, HttpStepResponse)
            and 200 <= response.status < 300
        )
        if not succeeded:
            status = f"HTTP {response.status}" if isinstance(response, HttpStepResponse) else None
            raise ClockPinError(
                f"the pin_clock hook did not accept the request: {record.error or status}"
            )


def identity_for_hook(manifest: BundleManifest, access: AccessResolver, interface_id: str) -> str:
    for role in sorted(manifest.roles, key=lambda item: item.level, reverse=True):
        try:
            access.resolve(interface_id, role.id)
        except AdapterError:
            continue
        return role.id
    return ANONYMOUS_IDENTITY


def hook_interface(manifest: BundleManifest, environment: ResolvedEnvironment) -> ResolvedInterface:
    for declared in manifest.interfaces:
        try:
            resolved = resolve_interface(manifest, declared.id, environment)
        except AdapterError:
            continue
        return replace(resolved, kind=AdapterKind.http, base_url=resolved.origin)
    raise ClockPinError(
        "no interface of the bundle has a URL the pin_clock hook can be called on",
        retryable=False,
    )


def hook_context(
    manifest: BundleManifest, environment: ResolvedEnvironment, limits: AdapterLimits
) -> AdapterContext:
    interface = hook_interface(manifest, environment)
    access = AccessResolver(manifest, environment)
    return AdapterContext(
        interface=interface,
        role=identity_for_hook(manifest, access, interface.id),
        access=access,
        environment=environment,
        redactor=environment.new_redactor(),
        limits=limits,
    )


class ClockResolver:
    def __init__(
        self,
        session_factory: SessionFactory,
        vault: Vault,
        registry: AdapterRegistry,
        settings: WorkerSettings,
        now: Callable[[], datetime] = utc_now,
    ) -> None:
        self.session_factory = session_factory
        self.vault = vault
        self.registry = registry
        self.settings = settings
        self.now = now

    async def resolve(
        self,
        target_id: uuid.UUID,
        bundle_id: uuid.UUID | None,
        base_url_override: str | None = None,
    ) -> ClockSnapshot:
        at = self.now()
        async with self.session_factory() as session:
            bundle = await self.find_bundle(session, target_id, bundle_id)
            manifest = BundleManifest.model_validate(bundle.manifest) if bundle else None
            hook = pin_clock_hook(manifest) if manifest else None
            if manifest is None or hook is None:
                return ClockSnapshot(mode="real", at=at)
            environment = await load_environment(session, self.vault, target_id)
        try:
            environment = override_environment(manifest, environment, base_url_override)
        except OverrideNotApplicableError as error:
            raise ClockPinError(str(error), retryable=False) from None
        await self.pin(manifest, environment, hook_endpoint(hook), at)
        return ClockSnapshot(mode="pinned", at=at)

    async def find_bundle(
        self, session: AsyncSession, target_id: uuid.UUID, bundle_id: uuid.UUID | None
    ) -> BundleRow | None:
        if bundle_id is not None:
            return await session.get(BundleRow, bundle_id)
        return await session.scalar(
            select(BundleRow)
            .where(
                BundleRow.target_id == target_id,
                BundleRow.validation_status == BundleValidationStatus.valid,
            )
            .order_by(BundleRow.version.desc())
            .limit(1)
        )

    async def pin(
        self,
        manifest: BundleManifest,
        environment: ResolvedEnvironment,
        endpoint: HookEndpoint,
        at: datetime,
    ) -> None:
        limits = AdapterLimits.from_settings(self.settings, HOOK_TIMEOUT_SECONDS)
        try:
            context = hook_context(manifest, environment, limits)
            adapter = await self.registry.open(context)
        except AdapterError as error:
            raise ClockPinError(
                f"the pin_clock hook cannot be called: {error}", retryable=False
            ) from None
        pinner: ClockPinning = HookClockPinner(adapter, endpoint)
        try:
            await pinner.pin_clock(at)
        finally:
            await adapter.close()
