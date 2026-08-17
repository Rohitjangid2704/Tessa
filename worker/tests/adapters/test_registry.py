import pytest

from tessa_api.schemas.enums import AdapterKind, HealthCheckStatus
from tessa_api.schemas.health import HealthState
from tessa_api.schemas.scenario import ScenarioStep
from tessa_worker.adapters.base import Adapter, StepRecord, TargetTrace
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.errors import UnsupportedAdapterError
from tessa_worker.adapters.http import HttpAdapter
from tessa_worker.adapters.registry import AdapterRegistry, default_registry
from tessa_worker.adapters.sse import SseAdapter
from tests.adapters.support import local_context


class RecordingAdapter:
    kind = AdapterKind.browser

    def __init__(self, context: AdapterContext) -> None:
        self.context = context
        self.closed = False

    async def drive(self, step: ScenarioStep) -> StepRecord:
        raise NotImplementedError

    async def trace(self, trace_id: str) -> TargetTrace | None:
        return None

    async def health(self) -> HealthState:
        return HealthState(
            status=HealthCheckStatus.ok, checked_at=None, latency_ms=None, message=None
        )

    async def close(self) -> None:
        self.closed = True


async def open_recording_adapter(context: AdapterContext) -> Adapter:
    return RecordingAdapter(context)


BUILTIN_KINDS = {
    AdapterKind.http,
    AdapterKind.sse,
    AdapterKind.websocket,
    AdapterKind.graphql,
}


def test_the_default_registry_supports_every_builtin_kind_but_not_the_browser() -> None:
    registry = default_registry()
    assert registry.kinds == BUILTIN_KINDS
    assert all(registry.supports(kind) for kind in BUILTIN_KINDS)
    assert not registry.supports(AdapterKind.browser)


async def test_opening_picks_the_adapter_of_the_interface_kind() -> None:
    registry = default_registry()
    http = await registry.open(local_context("http://127.0.0.1:1", kind="http"))
    sse = await registry.open(local_context("http://127.0.0.1:1", kind="sse"))
    try:
        assert isinstance(http, HttpAdapter)
        assert isinstance(sse, SseAdapter)
        assert http.kind is AdapterKind.http
        assert sse.kind is AdapterKind.sse
    finally:
        await http.close()
        await sse.close()


async def test_the_browser_kind_is_refused_by_name_until_the_runtime_registers_it() -> None:
    registry = default_registry()
    with pytest.raises(UnsupportedAdapterError, match="browser") as caught:
        await registry.open(local_context("http://127.0.0.1:1", kind="browser", base_path="/"))
    assert caught.value.kind is AdapterKind.browser


@pytest.mark.parametrize(("kind", "base_path"), [("http", "/qa"), ("browser", "/")])
async def test_an_empty_registry_refuses_every_kind_by_name(kind: str, base_path: str) -> None:
    context = local_context("http://127.0.0.1:1", kind=kind, base_path=base_path)
    with pytest.raises(UnsupportedAdapterError, match=kind) as caught:
        await AdapterRegistry().open(context)
    assert caught.value.kind is AdapterKind(kind)


async def test_an_owner_registers_its_adapter_and_receives_the_context() -> None:
    registry = default_registry()
    registry.register(AdapterKind.browser, open_recording_adapter)
    context = local_context("http://127.0.0.1:1", kind="browser", base_path="/")
    adapter = await registry.open(context)
    assert isinstance(adapter, RecordingAdapter)
    assert adapter.context is context
    assert registry.supports(AdapterKind.browser)
    assert registry.kinds == BUILTIN_KINDS | {AdapterKind.browser}
    await adapter.close()
    assert adapter.closed


def test_a_kind_cannot_be_registered_twice() -> None:
    registry = AdapterRegistry()
    registry.register(AdapterKind.browser, open_recording_adapter)
    with pytest.raises(ValueError, match="browser"):
        registry.register(AdapterKind.browser, open_recording_adapter)


def test_an_empty_registry_supports_nothing() -> None:
    registry = AdapterRegistry()
    assert registry.kinds == frozenset()
    assert not registry.supports(AdapterKind.http)


def test_registries_are_independent() -> None:
    first = default_registry()
    second = default_registry()
    first.register(AdapterKind.browser, open_recording_adapter)
    assert not second.supports(AdapterKind.browser)
