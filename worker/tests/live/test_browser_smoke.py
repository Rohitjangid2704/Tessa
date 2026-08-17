import pytest

from tessa_api.ids import new_id
from tessa_api.schemas.scenario import BrowserStep
from tessa_worker.adapters.browser import BrowserRuntime
from tests.browser_site.site import TestSite
from tests.live.conftest import browser_context

pytestmark = pytest.mark.browser


async def test_the_first_step_runs_in_a_real_browser(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    adapter = await runtime.open_adapter(browser_context(site), new_id())
    try:
        record = await adapter.drive(
            BrowserStep.model_validate({"adapter": "browser", "action": "goto", "url": "/login"})
        )
        print(record.model_dump_json(indent=1))
    finally:
        await adapter.close()
    assert record.ok is True
