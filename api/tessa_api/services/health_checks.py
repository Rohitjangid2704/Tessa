import asyncio
import ipaddress
import re
import time
import uuid
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin, urlsplit

import asyncpg
import httpx
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, EnvironmentRow, Target
from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import (
    AdapterKind,
    BundleValidationStatus,
    EnvVarKind,
    HealthCheckStatus,
)
from tessa_api.schemas.health import HealthReport, HealthReportInterface, HealthState
from tessa_api.services.environment import resolve_values
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings

HTTP_KINDS = frozenset({AdapterKind.http.value, AdapterKind.sse.value, AdapterKind.browser.value})
ALLOWED_HTTP_SCHEMES = frozenset({"http", "https"})
POSTGRES_DRIVER_PREFIXES = ("postgres", "postgresql")
BLOCKED_HOSTNAMES = frozenset({"metadata.google.internal", "metadata"})
BLOCKED_ADDRESSES = frozenset({ipaddress.ip_address("fd00:ec2::254")})
PLACEHOLDER_PATTERN = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")
TRUTH_PREFIX = "truth:"
TRUTH_KIND = "truth_source"
MIN_REDACTED_LENGTH = 4
MAX_MESSAGE_LENGTH = 300
METADATA_REFUSAL = "The cloud metadata address is not checked"
STATUS_PRIORITY = {
    HealthCheckStatus.failed: 3,
    HealthCheckStatus.ok: 2,
    HealthCheckStatus.skipped: 1,
    HealthCheckStatus.unchecked: 0,
}


class DestinationRefused(Exception):
    pass


@dataclass(frozen=True)
class CheckOutcome:
    status: HealthCheckStatus
    latency_ms: int | None = None
    message: str | None = None


@dataclass
class EntryPlan:
    interface_id: str
    kind: str
    variables: list[str] = field(default_factory=list)
    probes: list[tuple[str | None, Awaitable[CheckOutcome]]] = field(default_factory=list)


def skipped(message: str) -> CheckOutcome:
    return CheckOutcome(HealthCheckStatus.skipped, None, message)


def failed(message: str, latency_ms: int | None = None) -> CheckOutcome:
    return CheckOutcome(HealthCheckStatus.failed, latency_ms, message)


async def settled(outcome: CheckOutcome) -> CheckOutcome:
    return outcome


def elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def redact(message: str, secrets: Mapping[str, SecretStr]) -> str:
    for name, secret in secrets.items():
        value = secret.get_secret_value()
        if len(value) >= MIN_REDACTED_LENGTH:
            message = message.replace(value, f"${{{name}}}")
    return message[:MAX_MESSAGE_LENGTH]


def describe_exception(error: Exception) -> str:
    if isinstance(error, httpx.ConnectError | ConnectionRefusedError):
        return "Connection refused or host unreachable"
    text = str(error).strip()
    return f"{type(error).__name__}: {text}" if text else type(error).__name__


def is_blocked_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_link_local or address in BLOCKED_ADDRESSES


async def ensure_allowed_destination(host: str | None) -> None:
    if not host:
        raise DestinationRefused("The URL has no host")
    if host.lower().rstrip(".") in BLOCKED_HOSTNAMES:
        raise DestinationRefused(METADATA_REFUSAL)
    try:
        addresses = [ipaddress.ip_address(host.strip("[]"))]
    except ValueError:
        try:
            resolved = await asyncio.get_running_loop().getaddrinfo(host, None)
        except OSError:
            return
        addresses = [ipaddress.ip_address(item[4][0]) for item in resolved]
    if any(is_blocked_address(address) for address in addresses):
        raise DestinationRefused(METADATA_REFUSAL)


def postgres_dsn(value: str) -> str | None:
    try:
        url = make_url(value.strip())
    except Exception:
        return None
    if not url.drivername.split("+", 1)[0].startswith(POSTGRES_DRIVER_PREFIXES):
        return None
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


async def check_http(
    url: str, accept_event_stream: bool, require_success: bool, timeout_seconds: float
) -> CheckOutcome:
    parts = urlsplit(url)
    if parts.scheme not in ALLOWED_HTTP_SCHEMES:
        return failed("Only http and https URLs are checked")
    try:
        await ensure_allowed_destination(parts.hostname)
    except DestinationRefused as refusal:
        return failed(str(refusal))
    headers = {"Accept": "text/event-stream" if accept_event_stream else "*/*"}
    started = time.perf_counter()
    async with (
        httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client,
        client.stream("GET", url, headers=headers) as response,
    ):
        status_code = response.status_code
    latency = elapsed_ms(started)
    reachable = 200 <= status_code < 300 if require_success else status_code < 500
    if reachable:
        return CheckOutcome(HealthCheckStatus.ok, latency, f"HTTP {status_code}")
    expectation = "expected 2xx" if require_success else "expected below 500"
    return failed(f"HTTP {status_code}, {expectation}", latency)


async def check_postgres(value: str, timeout_seconds: float) -> CheckOutcome:
    dsn = postgres_dsn(value)
    if dsn is None:
        scheme = urlsplit(value.strip()).scheme or "unknown"
        return skipped(f"Only Postgres connections are checked, this one is {scheme}")
    parsed = make_url(dsn)
    try:
        for host in (parsed.host, parsed.query.get("host")):
            if isinstance(host, str):
                await ensure_allowed_destination(host)
    except DestinationRefused as refusal:
        return failed(str(refusal))
    started = time.perf_counter()
    connection = await asyncpg.connect(dsn=dsn, timeout=timeout_seconds)
    try:
        await connection.fetchval("SELECT 1")
    finally:
        await connection.close()
    return CheckOutcome(HealthCheckStatus.ok, elapsed_ms(started), "SELECT 1 succeeded")


async def run_bounded(
    semaphore: asyncio.Semaphore,
    timeout_seconds: float,
    secrets: Mapping[str, SecretStr],
    operation: Awaitable[CheckOutcome],
) -> CheckOutcome:
    async with semaphore:
        started = time.perf_counter()
        try:
            async with asyncio.timeout(timeout_seconds):
                outcome = await operation
        except TimeoutError:
            return failed(f"Timed out after {timeout_seconds:g}s", elapsed_ms(started))
        except Exception as error:
            return failed(redact(describe_exception(error), secrets), elapsed_ms(started))
    message = redact(outcome.message, secrets) if outcome.message else None
    return CheckOutcome(outcome.status, outcome.latency_ms, message)


def combine(outcomes: Sequence[CheckOutcome]) -> CheckOutcome:
    if not outcomes:
        return skipped("Nothing to check")
    chosen = max(outcomes, key=lambda outcome: STATUS_PRIORITY[outcome.status])
    latencies = [item.latency_ms for item in outcomes if item.latency_ms is not None]
    messages = [item.message for item in outcomes if item.message]
    return CheckOutcome(
        chosen.status,
        max(latencies) if latencies else None,
        "; ".join(dict.fromkeys(messages)) or None,
    )


def substitute_placeholders(text: str, values: Mapping[str, SecretStr]) -> tuple[str, str | None]:
    missing: list[str] = []

    def replace(match: re.Match[str]) -> str:
        secret = values.get(match.group(1))
        if secret is None:
            missing.append(match.group(1))
            return match.group(0)
        return secret.get_secret_value()

    return PLACEHOLDER_PATTERN.sub(replace, text), (missing[0] if missing else None)


def resolve_http_targets(
    interface: Mapping[str, Any],
    linked_url_values: Sequence[str],
    values: Mapping[str, SecretStr],
) -> tuple[str, str | None] | CheckOutcome:
    base, missing = substitute_placeholders(str(interface.get("base_path") or ""), values)
    if missing is not None:
        return skipped(f"No value set for {missing}")
    if not base.lower().startswith(("http://", "https://")):
        if not linked_url_values:
            return skipped("No URL variable with a value is linked to this interface")
        origin = linked_url_values[0].strip().rstrip("/")
        base = f"{origin}/{base.lstrip('/')}" if base else origin
    health_endpoint = interface.get("health_endpoint")
    if not health_endpoint:
        return base, None
    health, missing = substitute_placeholders(str(health_endpoint), values)
    if missing is not None:
        return skipped(f"No value set for {missing}")
    return base, urljoin(base.rstrip("/") + "/", health)


def manifest_items(manifest: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    items = manifest.get(key)
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, Mapping)]


async def latest_valid_manifest(session: AsyncSession, target_id: uuid.UUID) -> Mapping[str, Any]:
    manifest: dict[str, Any] | None = await session.scalar(
        select(BundleRow.manifest)
        .where(
            BundleRow.target_id == target_id,
            BundleRow.validation_status == BundleValidationStatus.valid,
        )
        .order_by(BundleRow.version.desc())
        .limit(1)
    )
    if manifest is None:
        raise ApiError(
            409, "target_not_ready", "Upload a valid bundle before running health checks"
        )
    return manifest


def stored_report(target: Target) -> HealthReport:
    if target.health_report is None:
        return HealthReport(target_id=target.id, checked_at=None, interfaces=[])
    return HealthReport.model_validate(target.health_report)


def overall_status(health_report: dict[str, Any] | None) -> HealthCheckStatus:
    if health_report is None:
        return HealthCheckStatus.unchecked
    statuses = {entry["status"] for entry in health_report.get("interfaces", [])}
    if HealthCheckStatus.failed.value in statuses:
        return HealthCheckStatus.failed
    if HealthCheckStatus.ok.value in statuses:
        return HealthCheckStatus.ok
    if statuses:
        return HealthCheckStatus.skipped
    return HealthCheckStatus.unchecked


def unknown_interface_error(known_ids: Sequence[str], wanted: Sequence[str]) -> ApiError | None:
    details = [
        ErrorDetail(
            loc=["body", "interface_ids", index],
            code="unknown_interface",
            message="The latest valid bundle declares no such interface",
        )
        for index, interface_id in enumerate(wanted)
        if interface_id not in known_ids
    ]
    if not details:
        return None
    return ApiError(422, "validation_failed", "Request validation failed", details)


def missing_value_probe(name: str) -> tuple[str | None, Awaitable[CheckOutcome]]:
    return name, settled(skipped(f"No value set for {name}"))


def plan_interface(
    interface: Mapping[str, Any],
    linked: Sequence[EnvironmentRow],
    values: Mapping[str, SecretStr],
    timeout: float,
) -> EntryPlan:
    kind = str(interface.get("kind"))
    plan = EntryPlan(str(interface.get("id")), kind, [row.name for row in linked])
    if kind in HTTP_KINDS:
        url_rows = [row for row in linked if row.kind is EnvVarKind.url]
        valued = [row for row in url_rows if row.name in values]
        url_variable = valued[0].name if valued else None
        resolved = resolve_http_targets(
            interface, [values[row.name].get_secret_value() for row in valued], values
        )
        if isinstance(resolved, CheckOutcome):
            plan.probes.append((url_variable, settled(resolved)))
        else:
            base_url, health_url = resolved
            plan.probes.append(
                (
                    url_variable,
                    check_http(
                        health_url or base_url,
                        kind == AdapterKind.sse.value,
                        health_url is not None,
                        timeout,
                    ),
                )
            )
        for row in url_rows:
            if row.name not in values:
                plan.probes.append(missing_value_probe(row.name))
    else:
        plan.probes.append((None, settled(skipped(f"Interface kind {kind} is not checked yet"))))
    for row in linked:
        if row.kind is not EnvVarKind.dsn:
            continue
        if row.name in values:
            plan.probes.append(
                (row.name, check_postgres(values[row.name].get_secret_value(), timeout))
            )
        else:
            plan.probes.append(missing_value_probe(row.name))
    return plan


def plan_truth_source(
    truth: Mapping[str, Any], values: Mapping[str, SecretStr], timeout: float
) -> EntryPlan:
    variable = str(truth.get("connection_env") or "")
    plan = EntryPlan(f"{TRUTH_PREFIX}{truth.get('id')}", TRUTH_KIND, [variable] if variable else [])
    if not variable:
        plan.probes.append((None, settled(skipped("No connection variable is declared"))))
        return plan
    if variable not in values:
        plan.probes.append(missing_value_probe(variable))
        return plan
    value = values[variable].get_secret_value()
    dialect = str(truth.get("dialect") or "")
    if truth.get("kind") == "read_endpoint":
        plan.probes.append((variable, check_http(value.strip(), False, False, timeout)))
    elif dialect and not dialect.lower().startswith("postgres"):
        plan.probes.append((variable, settled(skipped(f"Only Postgres is checked, not {dialect}"))))
    else:
        plan.probes.append((variable, check_postgres(value, timeout)))
    return plan


def merge_reports(
    previous: HealthReport, fresh: Mapping[str, HealthReportInterface], known_ids: Sequence[str]
) -> list[HealthReportInterface]:
    merged = {
        entry.interface_id: entry
        for entry in previous.interfaces
        if entry.interface_id in known_ids
    }
    merged.update(fresh)
    return [merged[known] for known in known_ids if known in merged]


async def run_health_checks(
    session: AsyncSession,
    settings: Settings,
    vault: Vault,
    target: Target,
    interface_ids: Sequence[str] | None,
) -> HealthReport:
    manifest = await latest_valid_manifest(session, target.id)
    interfaces = manifest_items(manifest, "interfaces")
    truth_sources = manifest_items(manifest, "truth_sources")
    known_ids = [str(item.get("id")) for item in interfaces] + [
        f"{TRUTH_PREFIX}{item.get('id')}" for item in truth_sources
    ]
    if interface_ids is not None and (error := unknown_interface_error(known_ids, interface_ids)):
        raise error
    selected = set(interface_ids) if interface_ids is not None else set(known_ids)

    rows = (
        await session.scalars(
            select(EnvironmentRow).where(
                EnvironmentRow.target_id == target.id, EnvironmentRow.stale.is_(False)
            )
        )
    ).all()
    values = await resolve_values(session, vault, target.id)
    rows_by_name = {row.name: row for row in rows}
    secret_values = {name: value for name, value in values.items() if rows_by_name[name].secret}
    timeout = float(settings.health_check_timeout_seconds)
    semaphore = asyncio.Semaphore(settings.health_check_concurrency)

    plans = [
        plan_interface(
            item,
            [row for row in rows if str(item.get("id")) in row.interface_ids],
            values,
            timeout,
        )
        for item in interfaces
        if str(item.get("id")) in selected
    ] + [
        plan_truth_source(item, values, timeout)
        for item in truth_sources
        if f"{TRUTH_PREFIX}{item.get('id')}" in selected
    ]
    flat = [(plan, variable, probe) for plan in plans for variable, probe in plan.probes]
    outcomes = await asyncio.gather(
        *(run_bounded(semaphore, timeout, secret_values, probe) for _, _, probe in flat)
    )

    now = datetime.now(UTC)
    outcomes_by_plan: dict[str, list[CheckOutcome]] = {plan.interface_id: [] for plan in plans}
    for (plan, variable, _), outcome in zip(flat, outcomes, strict=True):
        outcomes_by_plan[plan.interface_id].append(outcome)
        row = rows_by_name.get(variable) if variable is not None else None
        if row is not None:
            row.last_health = HealthState(
                status=outcome.status,
                checked_at=now,
                latency_ms=outcome.latency_ms,
                message=outcome.message,
            ).model_dump(mode="json")
    fresh: dict[str, HealthReportInterface] = {}
    for plan in plans:
        combined = combine(outcomes_by_plan[plan.interface_id])
        fresh[plan.interface_id] = HealthReportInterface(
            interface_id=plan.interface_id,
            kind=plan.kind,
            status=combined.status,
            latency_ms=combined.latency_ms,
            message=combined.message,
            variables=plan.variables,
        )
    report = HealthReport(
        target_id=target.id,
        checked_at=now,
        interfaces=merge_reports(stored_report(target), fresh, known_ids),
    )
    target.health_report = report.model_dump(mode="json")
    target.health_checked_at = now
    await session.flush()
    return report
