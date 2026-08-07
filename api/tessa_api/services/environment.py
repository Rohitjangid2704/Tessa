import logging
import math
import re
import uuid
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit

from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import EnvironmentRow
from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import EnvVarKind, HealthCheckStatus
from tessa_api.schemas.environment import (
    EnvironmentList,
    EnvironmentPatch,
    EnvironmentVariable,
)
from tessa_api.schemas.health import HealthState
from tessa_api.services.vault import Vault, VaultError

logger = logging.getLogger("tessa_api.environment")

NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")
ALWAYS_SECRET_KINDS = frozenset({EnvVarKind.dsn, EnvVarKind.token, EnvVarKind.password})
KIND_BY_SUFFIX: tuple[tuple[str, EnvVarKind], ...] = (
    ("_URL", EnvVarKind.url),
    ("_DSN", EnvVarKind.dsn),
    ("_TOKEN", EnvVarKind.token),
    ("_PASSWORD", EnvVarKind.password),
    ("_KEY", EnvVarKind.token),
    ("_SECRET", EnvVarKind.token),
)
UNCHECKED = HealthState(
    status=HealthCheckStatus.unchecked, checked_at=None, latency_ms=None, message=None
)


@dataclass(frozen=True)
class DeclaredVariable:
    name: str
    kind: str | None = None
    secret: bool | None = None
    required: bool = True
    purpose: str = ""
    interfaces: Sequence[str] = field(default_factory=tuple)


@dataclass(frozen=True)
class ReconcileResult:
    created: tuple[str, ...]
    updated: tuple[str, ...]
    stale: tuple[str, ...]


def infer_kind(name: str) -> EnvVarKind:
    upper = name.upper()
    for suffix, kind in KIND_BY_SUFFIX:
        if upper.endswith(suffix):
            return kind
    return EnvVarKind.string


def resolve_kind(name: str, declared_kind: str | None) -> EnvVarKind:
    if declared_kind:
        try:
            return EnvVarKind(declared_kind)
        except ValueError:
            return infer_kind(name)
    return infer_kind(name)


def effective_secret(kind: EnvVarKind, declared_secret: bool | None) -> bool:
    if kind in ALWAYS_SECRET_KINDS:
        return True
    return True if declared_secret is None else declared_secret


def merge_declarations(declared: Iterable[DeclaredVariable]) -> dict[str, DeclaredVariable]:
    merged: dict[str, DeclaredVariable] = {}
    for variable in declared:
        if not NAME_PATTERN.fullmatch(variable.name):
            raise ValueError(f"environment variable name {variable.name!r} is not valid")
        known = merged.get(variable.name)
        if known is None:
            merged[variable.name] = variable
            continue
        interfaces = list(dict.fromkeys([*known.interfaces, *variable.interfaces]))
        merged[variable.name] = DeclaredVariable(
            name=variable.name,
            kind=known.kind or variable.kind,
            secret=known.secret if known.secret is not None else variable.secret,
            required=known.required or variable.required,
            purpose=known.purpose or variable.purpose,
            interfaces=tuple(interfaces),
        )
    return merged


async def reconcile_environment(
    session: AsyncSession, target_id: uuid.UUID, declared: Iterable[DeclaredVariable]
) -> ReconcileResult:
    wanted = merge_declarations(declared)
    existing_rows = (
        await session.scalars(select(EnvironmentRow).where(EnvironmentRow.target_id == target_id))
    ).all()
    existing = {row.name: row for row in existing_rows}
    created: list[str] = []
    updated: list[str] = []
    for name, variable in wanted.items():
        kind = resolve_kind(name, variable.kind)
        secret = effective_secret(kind, variable.secret)
        row = existing.get(name)
        if row is None:
            session.add(
                EnvironmentRow(
                    target_id=target_id,
                    name=name,
                    kind=kind,
                    secret=secret,
                    required=variable.required,
                    purpose=variable.purpose,
                    interface_ids=list(variable.interfaces),
                    stale=False,
                )
            )
            created.append(name)
            continue
        keeps_secret_value = row.secret and row.encrypted_value is not None
        row.kind = kind
        row.secret = secret or keeps_secret_value
        row.required = variable.required
        row.purpose = variable.purpose
        row.interface_ids = list(variable.interfaces)
        row.stale = False
        updated.append(name)
    stale: list[str] = []
    for name, row in existing.items():
        if name not in wanted:
            if not row.stale:
                stale.append(name)
            row.stale = True
    await session.flush()
    return ReconcileResult(tuple(created), tuple(updated), tuple(stale))


def health_state_of(row: EnvironmentRow) -> HealthState:
    if row.last_health is None:
        return UNCHECKED
    return HealthState.model_validate(row.last_health)


def plain_value(row: EnvironmentRow, vault: Vault) -> str | None:
    if row.secret or row.encrypted_value is None:
        return None
    try:
        return vault.decrypt(row.encrypted_value).get_secret_value()
    except VaultError:
        logger.warning("environment_value_unreadable", extra={"variable": row.name})
        return None


def to_variable(row: EnvironmentRow, vault: Vault) -> EnvironmentVariable:
    return EnvironmentVariable(
        name=row.name,
        kind=row.kind,
        secret=row.secret,
        required=row.required,
        purpose=row.purpose,
        interface_ids=list(row.interface_ids),
        has_value=row.encrypted_value is not None,
        value=plain_value(row, vault),
        stale=row.stale,
        last_set_at=row.last_set_at,
        last_set_by=row.last_set_by,
        health=health_state_of(row),
    )


async def list_environment(
    session: AsyncSession, vault: Vault, target_id: uuid.UUID
) -> EnvironmentList:
    rows = (
        await session.scalars(
            select(EnvironmentRow)
            .where(EnvironmentRow.target_id == target_id)
            .order_by(EnvironmentRow.stale, EnvironmentRow.name)
        )
    ).all()
    missing = sum(
        1 for row in rows if row.required and not row.stale and row.encrypted_value is None
    )
    return EnvironmentList(
        items=[to_variable(row, vault) for row in rows], missing_required=missing
    )


def value_problem(kind: EnvVarKind, secret: bool, value: str) -> tuple[str, str] | None:
    if kind in {EnvVarKind.url, EnvVarKind.dsn}:
        parts = urlsplit(value.strip())
        if not parts.scheme or not parts.netloc:
            return "invalid_value", f"A {kind.value} variable needs a value like scheme://host"
        if kind is EnvVarKind.url and not secret and (parts.username or parts.password):
            return (
                "url_with_userinfo_not_allowed",
                "A URL that carries a username or password cannot be stored as a plain variable",
            )
    if kind is EnvVarKind.number:
        try:
            if not math.isfinite(float(value)):
                raise ValueError(value)
        except ValueError:
            return "invalid_value", "A number variable needs a finite number"
    if kind is EnvVarKind.bool_ and value.strip().lower() not in {"true", "false"}:
        return "invalid_value", "A bool variable needs true or false"
    return None


def normalise_value(kind: EnvVarKind, value: str) -> str:
    if kind is EnvVarKind.bool_:
        return value.strip().lower()
    if kind in {EnvVarKind.url, EnvVarKind.dsn, EnvVarKind.number}:
        return value.strip()
    return value


def patch_error(problems: list[ErrorDetail]) -> ApiError:
    return ApiError(422, "validation_failed", "Request validation failed", problems)


async def apply_environment_patch(
    session: AsyncSession,
    vault: Vault,
    target_id: uuid.UUID,
    user_id: uuid.UUID,
    patch: EnvironmentPatch,
) -> None:
    rows = (
        await session.scalars(select(EnvironmentRow).where(EnvironmentRow.target_id == target_id))
    ).all()
    by_name = {row.name: row for row in rows}
    problems: list[ErrorDetail] = []
    clear_names = list(dict.fromkeys(patch.clear))
    for name in patch.set:
        row = by_name.get(name)
        if row is None:
            problems.append(
                ErrorDetail(
                    loc=["body", "set", name],
                    code="unknown_variable",
                    message="The target does not declare this variable",
                )
            )
        elif name in clear_names:
            problems.append(
                ErrorDetail(
                    loc=["body", "set", name],
                    code="conflicting_operation",
                    message="The variable is both set and cleared",
                )
            )
        elif (problem := value_problem(row.kind, row.secret, patch.set[name])) is not None:
            problems.append(
                ErrorDetail(loc=["body", "set", name], code=problem[0], message=problem[1])
            )
    for index, name in enumerate(clear_names):
        if name not in by_name:
            problems.append(
                ErrorDetail(
                    loc=["body", "clear", index],
                    code="unknown_variable",
                    message="The target does not declare this variable",
                )
            )
    if problems:
        raise patch_error(problems)
    now = datetime.now(UTC)
    for name, value in patch.set.items():
        row = by_name[name]
        row.encrypted_value = vault.encrypt(normalise_value(row.kind, value))
        mark_changed(row, user_id, now)
    for name in clear_names:
        row = by_name[name]
        row.encrypted_value = None
        mark_changed(row, user_id, now)
    await session.flush()


def mark_changed(row: EnvironmentRow, user_id: uuid.UUID, now: datetime) -> None:
    row.last_set_at = now
    row.last_set_by = user_id
    row.last_health = None


async def resolve_values(
    session: AsyncSession,
    vault: Vault,
    target_id: uuid.UUID,
    names: Collection[str] | None = None,
    include_stale: bool = False,
) -> dict[str, SecretStr]:
    statement = select(EnvironmentRow.name, EnvironmentRow.encrypted_value).where(
        EnvironmentRow.target_id == target_id, EnvironmentRow.encrypted_value.is_not(None)
    )
    if not include_stale:
        statement = statement.where(EnvironmentRow.stale.is_(False))
    if names is not None:
        statement = statement.where(EnvironmentRow.name.in_(list(names)))
    resolved: dict[str, SecretStr] = {}
    for name, ciphertext in await session.execute(statement):
        if ciphertext is not None:
            resolved[name] = vault.decrypt(ciphertext)
    return resolved
