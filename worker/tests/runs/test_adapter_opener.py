from dataclasses import replace

import pytest

from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.enums import AdapterKind, SkipReason
from tessa_worker.activities.adapter_opener import RegistryAdapterOpener
from tessa_worker.activities.drive_ports import AdapterOpenError, AdapterOpenRequest
from tessa_worker.adapters.registry import default_registry
from tessa_worker.settings import WorkerSettings
from tests.adapters.support import RegisteredTarget
from tests.fake_target.dataset import STAFF_PASSWORD

pytestmark = pytest.mark.integration


@pytest.fixture
def opener(
    session_factory: SessionFactory, registered: RegisteredTarget, worker_settings: WorkerSettings
) -> RegistryAdapterOpener:
    return RegistryAdapterOpener(
        session_factory, registered.vault, default_registry(), worker_settings
    )


def request_for(
    registered: RegisteredTarget, role: str = "staff", interface_id: str = "api"
) -> AdapterOpenRequest:
    return AdapterOpenRequest(
        target_id=registered.target_id,
        bundle_id=registered.bundle_id,
        role=role,
        interface_id=interface_id,
        run_id=new_id(),
        run_scenario_id=new_id(),
        attempt=0,
        read_only=False,
        step_timeout_seconds=10.0,
        browser_session_id=new_id(),
    )


async def test_an_http_interface_opens_an_http_adapter_with_the_secrets_of_the_target_redacted(
    opener: RegistryAdapterOpener, registered: RegisteredTarget
) -> None:
    opened = await opener.open(request_for(registered))
    try:
        assert opened.adapter.kind is AdapterKind.http
        assert opened.redact(f"password {STAFF_PASSWORD} was sent") == (
            "password ${STAFF_PASSWORD} was sent"
        )
        assert opened.tier0_context.internal_id_patterns
    finally:
        await opened.adapter.close()


async def test_a_streaming_interface_opens_an_sse_adapter(
    opener: RegistryAdapterOpener, registered: RegisteredTarget
) -> None:
    opened = await opener.open(request_for(registered, role="manager", interface_id="chat_sse"))
    try:
        assert opened.adapter.kind is AdapterKind.sse
    finally:
        await opened.adapter.close()


async def test_an_interface_kind_without_an_adapter_is_reported_with_the_kind(
    opener: RegistryAdapterOpener, registered: RegisteredTarget
) -> None:
    with pytest.raises(AdapterOpenError, match=r"UnsupportedAdapterError.*browser") as caught:
        await opener.open(request_for(registered, interface_id="browser"))
    assert caught.value.skip_reason is SkipReason.adapter_unsupported


async def test_a_run_whose_bundle_is_gone_cannot_open_an_adapter(
    opener: RegistryAdapterOpener, registered: RegisteredTarget
) -> None:
    request = replace(request_for(registered), bundle_id=new_id())
    with pytest.raises(AdapterOpenError, match="no readable manifest"):
        await opener.open(request)
