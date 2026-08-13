from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import AdapterKind
from tessa_worker.adapters.auth import AccessResolver, ResolvedEnvironment
from tessa_worker.adapters.errors import InterfaceUnresolvedError
from tessa_worker.adapters.redact import Redactor
from tessa_worker.settings import WorkerSettings

ABSOLUTE_URL_PREFIXES = ("http://", "https://", "ws://", "wss://")
DEFAULT_WS_MAX_MESSAGES = 200


@dataclass(frozen=True)
class AdapterLimits:
    max_payload_bytes: int
    step_timeout_seconds: float
    ws_max_messages: int = DEFAULT_WS_MAX_MESSAGES

    @classmethod
    def from_settings(
        cls, settings: WorkerSettings, step_timeout_seconds: float
    ) -> "AdapterLimits":
        return cls(
            max_payload_bytes=settings.step_max_payload_bytes,
            step_timeout_seconds=step_timeout_seconds,
            ws_max_messages=settings.ws_adapter_max_messages,
        )


@dataclass(frozen=True)
class RunScope:
    read_only: bool = False
    production: bool = False

    @classmethod
    def for_run(cls, read_only: bool) -> "RunScope":
        return cls(read_only=read_only, production=read_only)


NO_SCOPE = RunScope()


@dataclass(frozen=True)
class ResolvedInterface:
    id: str
    kind: AdapterKind
    origin: str
    base_url: str
    health_url: str | None


@dataclass(frozen=True)
class AdapterContext:
    interface: ResolvedInterface
    role: str
    access: AccessResolver
    environment: ResolvedEnvironment
    redactor: Redactor
    limits: AdapterLimits
    scope: RunScope = NO_SCOPE


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def resolve_interface(
    manifest: BundleManifest,
    interface_id: str,
    environment: ResolvedEnvironment,
    needs_network: bool = True,
) -> ResolvedInterface:
    declared = next((item for item in manifest.interfaces if item.id == interface_id), None)
    if declared is None:
        raise InterfaceUnresolvedError(f"the bundle declares no interface {interface_id}")
    if not needs_network:
        return ResolvedInterface(
            id=interface_id, kind=declared.kind, origin="", base_url="", health_url=None
        )
    base_path = environment.substitute(declared.base_path).strip()
    if base_path.lower().startswith(ABSOLUTE_URL_PREFIXES):
        origin = origin_of(base_path)
        base_url = base_path.rstrip("/")
    else:
        linked = environment.urls_for(interface_id)
        if not linked:
            raise InterfaceUnresolvedError(
                f"no URL variable with a value is linked to interface {interface_id}"
            )
        origin = linked[0].value.strip().rstrip("/")
        base_url = f"{origin}/{base_path.lstrip('/')}".rstrip("/")
    health_url = None
    if declared.health_endpoint:
        health = environment.substitute(declared.health_endpoint).strip()
        health_url = urljoin(base_url.rstrip("/") + "/", health)
    return ResolvedInterface(
        id=interface_id,
        kind=declared.kind,
        origin=origin,
        base_url=base_url,
        health_url=health_url,
    )


def build_adapter_context(
    manifest: BundleManifest,
    environment: ResolvedEnvironment,
    role: str,
    interface_id: str,
    limits: AdapterLimits,
    scope: RunScope = NO_SCOPE,
    needs_network: bool = True,
) -> AdapterContext:
    return AdapterContext(
        interface=resolve_interface(manifest, interface_id, environment, needs_network),
        role=role,
        access=AccessResolver(manifest, environment),
        environment=environment,
        redactor=environment.new_redactor(),
        limits=limits,
        scope=scope,
    )
