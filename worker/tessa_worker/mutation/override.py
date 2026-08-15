import uuid
from dataclasses import replace
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import RunRow
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import EnvVarKind
from tessa_worker.adapters.auth import EnvironmentValue, ResolvedEnvironment

DEFAULT_PORTS = {"http": 80, "https": 443}
OVERRIDE_KEY = "base_url_override"


class OverrideNotApplicableError(Exception):
    pass


def normalized_origin(url: str) -> str | None:
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in DEFAULT_PORTS or not parts.hostname:
        return None
    host = parts.hostname.lower()
    shown_host = f"[{host}]" if ":" in host else host
    shown_port = "" if port is None or port == DEFAULT_PORTS[parts.scheme] else f":{port}"
    return f"{parts.scheme}://{shown_host}{shown_port}"


def primary_origin(manifest: BundleManifest, environment: ResolvedEnvironment) -> str | None:
    for interface in manifest.interfaces:
        for variable in environment.urls_for(interface.id):
            origin = normalized_origin(variable.value)
            if origin is not None:
                return origin
    return None


def replaced_value(value: str, primary: str, override: str) -> str | None:
    if normalized_origin(value) != primary:
        return None
    parts = urlsplit(value.strip())
    remainder = urlunsplit(("", "", parts.path, parts.query, parts.fragment))
    return f"{override.rstrip('/')}{remainder}"


def apply_base_url_override(
    manifest: BundleManifest, environment: ResolvedEnvironment, override: str
) -> ResolvedEnvironment:
    primary = primary_origin(manifest, environment)
    if primary is None:
        raise OverrideNotApplicableError(
            "no URL variable with a value is linked to an interface of the bundle, so there is no "
            "origin to replace"
        )
    values: list[EnvironmentValue] = []
    for value in environment.all_values():
        replacement = (
            replaced_value(value.value, primary, override) if value.kind is EnvVarKind.url else None
        )
        values.append(value if replacement is None else replace(value, value=replacement))
    return ResolvedEnvironment(values)


def override_environment(
    manifest: BundleManifest, environment: ResolvedEnvironment, override: str | None
) -> ResolvedEnvironment:
    if override is None:
        return environment
    return apply_base_url_override(manifest, environment, override)


async def read_base_url_override(session: AsyncSession, run_id: uuid.UUID) -> str | None:
    snapshot = await session.scalar(select(RunRow.config_snapshot).where(RunRow.id == run_id))
    if not isinstance(snapshot, dict):
        return None
    value = snapshot.get(OVERRIDE_KEY)
    return value if isinstance(value, str) and value else None
