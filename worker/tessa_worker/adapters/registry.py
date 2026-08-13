from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from tessa_api.schemas.enums import AdapterKind
from tessa_worker.adapters.base import DEFAULT_CAPABILITIES, Adapter, AdapterCapabilities
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.errors import AdapterRefusedError, UnsupportedAdapterError
from tessa_worker.adapters.graphql import GRAPHQL_CAPABILITIES, open_graphql_adapter
from tessa_worker.adapters.http import open_http_adapter
from tessa_worker.adapters.sse import open_sse_adapter
from tessa_worker.adapters.websocket import WEBSOCKET_CAPABILITIES, open_websocket_adapter

AdapterFactory = Callable[[AdapterContext], Awaitable[Adapter]]


@dataclass(frozen=True)
class AdapterRegistration:
    kind: AdapterKind
    factory: AdapterFactory
    capabilities: AdapterCapabilities = DEFAULT_CAPABILITIES


BUILTIN_ADAPTERS: tuple[AdapterRegistration, ...] = (
    AdapterRegistration(AdapterKind.http, open_http_adapter),
    AdapterRegistration(AdapterKind.sse, open_sse_adapter),
    AdapterRegistration(AdapterKind.websocket, open_websocket_adapter, WEBSOCKET_CAPABILITIES),
    AdapterRegistration(AdapterKind.graphql, open_graphql_adapter, GRAPHQL_CAPABILITIES),
)


class AdapterRegistry:
    def __init__(self) -> None:
        self._factories: dict[AdapterKind, AdapterFactory] = {}
        self._capabilities: dict[AdapterKind, AdapterCapabilities] = {}

    def register(
        self,
        kind: AdapterKind,
        factory: AdapterFactory,
        capabilities: AdapterCapabilities = DEFAULT_CAPABILITIES,
    ) -> None:
        if kind in self._factories:
            raise ValueError(f"an adapter for interface kind {kind.value} is already registered")
        self._factories[kind] = factory
        self._capabilities[kind] = capabilities

    def capabilities_of(self, kind: AdapterKind) -> AdapterCapabilities:
        capabilities = self._capabilities.get(kind)
        if capabilities is None:
            raise UnsupportedAdapterError(kind)
        return capabilities

    def supports(self, kind: AdapterKind) -> bool:
        return kind in self._factories

    def needs_network(self, kind: AdapterKind | None) -> bool:
        if kind is None or kind not in self._capabilities:
            return True
        return self._capabilities[kind].needs_network

    def drives(self, kind: AdapterKind, step_kind: str) -> bool:
        return self.capabilities_of(kind).drives(kind, step_kind)

    def refusal(self, context: AdapterContext) -> str | None:
        kind = context.interface.kind
        capabilities = self.capabilities_of(kind)
        scope = context.scope
        if scope.production and not capabilities.allowed_on_production:
            return (
                f"the {kind.value} adapter is not allowed on production targets, "
                "this run is read-only"
            )
        if scope.read_only and not capabilities.allowed_on_read_only:
            return f"the {kind.value} adapter is not allowed on read-only runs"
        return None

    @property
    def kinds(self) -> frozenset[AdapterKind]:
        return frozenset(self._factories)

    async def open(self, context: AdapterContext) -> Adapter:
        kind = context.interface.kind
        factory = self._factories.get(kind)
        if factory is None:
            raise UnsupportedAdapterError(kind)
        reason = self.refusal(context)
        if reason is not None:
            raise AdapterRefusedError(kind, reason)
        return await factory(context)


def default_registry() -> AdapterRegistry:
    registry = AdapterRegistry()
    for registration in BUILTIN_ADAPTERS:
        registry.register(registration.kind, registration.factory, registration.capabilities)
    return registry
