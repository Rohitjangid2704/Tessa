import asyncio
import contextlib
import json
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import yaml

from tessa_api.ids import new_id
from tessa_api.schemas.bundle_files import Flow
from tessa_api.schemas.enums import AdapterKind, ArtifactKind, HealthCheckStatus
from tessa_api.schemas.scenario import BrowserStep, HttpStep
from tessa_api.schemas.steps import BrowserStepRequest, BrowserStepResponse
from tessa_api.services.smoke_generator import browser_steps
from tessa_worker.adapters.base import Adapter, StepRecord
from tessa_worker.adapters.browser import BrowserAdapter, BrowserRuntime, UnsupportedStepError
from tessa_worker.settings import WorkerSettings
from tests.browser_site.pages import LOGIN_PASSWORD
from tests.browser_site.site import TestSite
from tests.live.conftest import browser_context

pytestmark = pytest.mark.browser

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
WEBM_MAGIC = b"\x1a\x45\xdf\xa3"

LOGIN_AND_CHAT = """
id: login_and_chat
title: Sign in and chat
feature_ids: [auth.login, chat.ask]
role: staff
steps:
  - action: goto
    url: /login
    expect: {url: /login}
  - action: fill
    target: {role: textbox, name: Email}
    value: ${STAFF_EMAIL}
  - action: fill
    target: {selector: "[data-testid=password]"}
    value: ${STAFF_PASSWORD}
  - action: click
    target: {role: button, name: Sign in}
    expect:
      url: /chat
      text: [Chat]
      text_not: [Invalid credentials]
  - action: fill
    target: {selector: "[data-testid=chat-input]"}
    value: Which rooms are still dirty?
  - action: press
    value: Enter
    expect:
      text: ["You said: Which rooms are still dirty?"]
"""


def browser_step(action: str, **fields: Any) -> BrowserStep:
    return BrowserStep.model_validate({"adapter": "browser", "action": action, **fields})


def request_of(record: StepRecord) -> BrowserStepRequest:
    assert isinstance(record.request, BrowserStepRequest)
    return record.request


def scenario_steps(flow: Flow) -> list[BrowserStep]:
    return [BrowserStep.model_validate(document) for document in browser_steps(flow, None)]


def response_of(record: StepRecord) -> BrowserStepResponse:
    assert isinstance(record.response, BrowserStepResponse)
    return record.response


@contextlib.asynccontextmanager
async def opened(
    runtime: BrowserRuntime, site: TestSite, **context_options: Any
) -> AsyncIterator[BrowserAdapter]:
    adapter = await runtime.open_adapter(browser_context(site, **context_options), new_id())
    try:
        yield adapter
    finally:
        await adapter.close()


def trace_entries(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


async def test_the_adapter_is_a_browser_adapter_with_the_viewport_of_its_context(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        assert isinstance(adapter, Adapter)
        assert adapter.kind is AdapterKind.browser
        assert (adapter.viewport.width, adapter.viewport.height) == (1280, 720)
        health = await adapter.health()
        assert health.status is HealthCheckStatus.ok
        assert await adapter.trace("anything") is None


async def test_the_login_and_chat_flow_runs_step_by_step(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    flow = Flow.model_validate(yaml.safe_load(LOGIN_AND_CHAT))
    async with opened(runtime, site) as adapter:
        records = [await adapter.drive(step) for step in scenario_steps(flow)]
    assert [record.ok for record in records] == [True] * 6, [record.error for record in records]
    assert [request_of(record).action for record in records] == [
        "navigate",
        "type",
        "type",
        "click",
        "type",
        "press",
    ]
    sign_in = response_of(records[3])
    assert sign_in.url.endswith("/chat")
    assert sign_in.title == "Test Site - Chat"
    assert sign_in.dom_state is not None
    assert sign_in.dom_state.text_found == {"Chat": True, "Invalid credentials": False}
    answer = response_of(records[5])
    assert "You said: Which rooms are still dirty?" in (answer.text_excerpt or "")


async def test_every_step_files_a_screenshot_and_a_trace_chunk_and_the_session_a_recording(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        first = await adapter.drive(browser_step("goto", url="/login"))
        second = await adapter.drive(browser_step("goto", url="/static"))
    for record in (first, second):
        kinds = sorted(item.kind.value for item in record.artifacts)
        assert kinds == ["screenshot", "trace"]
        screenshot = next(a for a in record.artifacts if a.kind is ArtifactKind.screenshot)
        trace = next(a for a in record.artifacts if a.kind is ArtifactKind.trace)
        assert screenshot.mime == "image/png"
        assert screenshot.path.read_bytes().startswith(PNG_MAGIC)
        assert trace.mime == "application/zip"
        assert "trace.trace" in trace_entries(trace.path)
    assert {item.path for item in first.artifacts}.isdisjoint(
        {item.path for item in second.artifacts}
    )
    produced = await adapter.session_artifacts()
    assert [(item.kind, item.mime) for item in produced] == [(ArtifactKind.recording, "video/webm")]
    assert produced[0].path.read_bytes().startswith(WEBM_MAGIC)


async def test_artifact_paths_are_built_from_ids_only_and_stay_short(
    runtime: BrowserRuntime, site: TestSite, browser_settings: WorkerSettings
) -> None:
    session_id = new_id()
    adapter = await runtime.open_adapter(browser_context(site), session_id)
    try:
        record = await adapter.drive(browser_step("goto", url="/static"))
    finally:
        await adapter.close()
    scratch_root = browser_settings.data_dir / "browser" / "scratch"
    for item in record.artifacts:
        relative = item.path.relative_to(scratch_root)
        assert len(relative.parts) == 3
        assert relative.parts[1] == session_id.hex[:12]
        assert len(str(relative)) < 60


async def test_the_trace_of_a_login_step_does_not_hold_the_password(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        await adapter.drive(browser_step("goto", url="/login"))
        record = await adapter.drive(
            browser_step(
                "fill", target={"selector": "[data-testid=password]"}, value="${STAFF_PASSWORD}"
            )
        )
    trace = next(item for item in record.artifacts if item.kind is ArtifactKind.trace)
    entries = trace_entries(trace.path)
    assert any(b"${STAFF_PASSWORD}" in content for content in entries.values())
    assert all(LOGIN_PASSWORD.encode() not in content for content in entries.values())


async def test_the_record_never_holds_a_secret_that_the_page_echoes(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        record = await adapter.drive(browser_step("goto", url="/echo?text=${STAFF_PASSWORD}"))
    dumped = record.model_dump_json()
    assert LOGIN_PASSWORD not in dumped
    assert response_of(record).text_excerpt is not None
    assert "${STAFF_PASSWORD}" in (response_of(record).text_excerpt or "")
    assert "${STAFF_PASSWORD}" in (request_of(record).url or "")
    assert record.ok is True


async def test_a_value_is_typed_for_real_and_the_request_keeps_the_placeholder(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        await adapter.drive(browser_step("goto", url="/login"))
        await adapter.drive(
            browser_step(
                "fill", target={"role": "textbox", "name": "Email"}, value="${STAFF_EMAIL}"
            )
        )
        await adapter.drive(
            browser_step(
                "fill", target={"selector": "[data-testid=password]"}, value="${STAFF_PASSWORD}"
            )
        )
        record = await adapter.drive(
            browser_step(
                "click",
                target={"role": "button", "name": "Sign in"},
                expect={"dom_state": {"url": "/chat"}},
            )
        )
    assert record.ok is True
    assert response_of(record).url.endswith("/chat")


async def test_console_messages_and_page_errors_are_captured_for_the_step(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        quiet = await adapter.drive(browser_step("goto", url="/chat"))
        failing = await adapter.drive(browser_step("goto", url="/chat?fail=console"))
        crashing = await adapter.drive(
            browser_step(
                "goto",
                url="/chat?fail=exception",
                expect={"dom_state": {"text_contains": ["Chat"]}},
            )
        )
        await asyncio.sleep(0.3)
        later = await adapter.drive(
            browser_step("wait_for", expect={"dom_state": {"url": "/chat"}})
        )
    assert [(m.level, m.text) for m in response_of(quiet).console] == [("info", "chat ready")]
    assert ("error", "deliberate console error") in [
        (m.level, m.text) for m in response_of(failing).console
    ]
    page_errors = response_of(crashing).console + response_of(later).console
    assert any(m.level == "error" and "deliberate page error" in m.text for m in page_errors)


async def test_the_missing_favicon_does_not_pollute_the_console(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        record = await adapter.drive(browser_step("goto", url="/static"))
        await asyncio.sleep(0.3)
        follow = await adapter.drive(
            browser_step("wait_for", expect={"dom_state": {"url": "/static"}})
        )
    assert response_of(record).console == []
    assert response_of(follow).console == []


async def test_the_page_state_the_step_expects_is_observed(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        record = await adapter.drive(
            browser_step(
                "goto",
                url="/form",
                expect={
                    "dom_state": {
                        "text_contains": ["preferences", "Hover over me"],
                        "text_not_contains": ["Unexpected"],
                        "visible": [{"role": "button", "name": "Save as"}],
                        "hidden": [{"selector": "#nothing-here"}],
                    }
                },
            )
        )
    observed = response_of(record).dom_state
    assert observed is not None
    assert observed.text_found == {"preferences": True, "Hover over me": True, "Unexpected": False}
    assert observed.elements == {
        "role=button name=Save as": "visible",
        "selector=#nothing-here": "missing",
    }


async def test_a_hidden_element_is_reported_as_hidden_not_missing(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        record = await adapter.drive(
            browser_step(
                "goto",
                url="/login",
                expect={"dom_state": {"hidden": [{"selector": "#error"}]}},
            )
        )
    observed = response_of(record).dom_state
    assert observed is not None
    assert list(observed.elements.values()) == ["hidden"]


async def test_select_check_hover_and_press_act_on_the_page(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        await adapter.drive(browser_step("goto", url="/form"))
        selected = await adapter.drive(
            browser_step(
                "select",
                target={"role": "combobox", "name": "Colour"},
                value="Green",
                expect={"dom_state": {"text_contains": ["colour g"]}},
            )
        )
        checked = await adapter.drive(
            browser_step(
                "check",
                target={"role": "checkbox", "name": "Subscribe"},
                expect={"dom_state": {"text_contains": ["subscribed"]}},
            )
        )
        hovered = await adapter.drive(
            browser_step(
                "hover",
                target={"selector": "#hover"},
                expect={"dom_state": {"text_contains": ["hovered"]}},
            )
        )
        pressed = await adapter.drive(
            browser_step(
                "press", value="Shift", expect={"dom_state": {"text_contains": ["key Shift"]}}
            )
        )
        pressed_on = await adapter.drive(
            browser_step(
                "press",
                target={"selector": "#hover"},
                value="x",
                expect={"dom_state": {"text_contains": ["key x"]}},
            )
        )
    for record in (selected, checked, hovered, pressed, pressed_on):
        assert record.ok is True, record.error
        assert dom_ok(record)


def dom_ok(record: StepRecord) -> bool:
    observed = response_of(record).dom_state
    return observed is not None and all(observed.text_found.values())


async def test_wait_for_returns_when_the_expected_text_shows_up(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        await adapter.drive(browser_step("goto", url="/chat"))
        await adapter.drive(
            browser_step("fill", target={"selector": "[data-testid=chat-input]"}, value="hi")
        )
        await adapter.drive(browser_step("press", value="Enter"))
        record = await adapter.drive(
            browser_step("wait_for", expect={"dom_state": {"text_contains": ["You said: hi"]}})
        )
    assert record.ok is True
    assert record.latency_ms >= 100


async def test_wait_for_that_never_holds_fails_the_step_and_keeps_the_last_observation(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site, step_timeout_seconds=1.0) as adapter:
        await adapter.drive(browser_step("goto", url="/static"))
        record = await adapter.drive(
            browser_step("wait_for", expect={"dom_state": {"text_contains": ["never appears"]}})
        )
    assert record.ok is False
    assert record.error == "the page did not reach the expected state in time"
    observed = response_of(record).dom_state
    assert observed is not None
    assert observed.text_found == {"never appears": False}
    assert record.latency_ms >= 900


async def test_an_expectation_that_does_not_hold_is_reported_without_failing_the_step(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site, step_timeout_seconds=1.0) as adapter:
        record = await adapter.drive(
            browser_step(
                "goto", url="/static", expect={"dom_state": {"text_contains": ["missing"]}}
            )
        )
    assert record.ok is True
    assert response_of(record).dom_state is not None


async def test_an_element_that_is_not_there_fails_the_step_with_a_short_reason(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site, step_timeout_seconds=1.0) as adapter:
        await adapter.drive(browser_step("goto", url="/static"))
        record = await adapter.drive(
            browser_step("click", target={"role": "button", "name": "Does not exist"})
        )
    assert record.ok is False
    assert record.error is not None
    assert "\n" not in record.error
    assert len(record.error) <= 300
    assert record.artifacts


async def test_an_exact_accessible_name_wins_over_longer_names_that_contain_it(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site, step_timeout_seconds=2.0) as adapter:
        await adapter.drive(browser_step("goto", url="/form"))
        record = await adapter.drive(
            browser_step("click", target={"role": "button", "name": "Save"})
        )
    assert record.ok is True, record.error


async def test_a_partial_name_that_matches_several_elements_fails_the_step(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site, step_timeout_seconds=2.0) as adapter:
        await adapter.drive(browser_step("goto", url="/form"))
        record = await adapter.drive(
            browser_step("click", target={"role": "button", "name": "sav"})
        )
    assert record.ok is False
    assert "strict mode" in (record.error or "").lower()


async def test_a_partial_name_that_matches_one_element_is_enough(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site, step_timeout_seconds=2.0) as adapter:
        await adapter.drive(browser_step("goto", url="/form"))
        record = await adapter.drive(
            browser_step(
                "check",
                target={"role": "checkbox", "name": "subscribe"},
                expect={"dom_state": {"text_contains": ["subscribed"]}},
            )
        )
    assert record.ok is True, record.error
    observed = response_of(record).dom_state
    assert observed is not None
    assert observed.text_found == {"subscribed": True}


async def test_a_step_that_needs_a_missing_variable_fails_without_naming_a_value(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        await adapter.drive(browser_step("goto", url="/login"))
        record = await adapter.drive(
            browser_step("fill", target={"selector": "#email"}, value="${NOT_SET}")
        )
    assert record.ok is False
    assert record.error == "no value is set for ${NOT_SET}"


async def test_navigation_to_another_origin_is_refused(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        record = await adapter.drive(browser_step("goto", url="http://example.invalid/steal"))
    assert record.ok is False
    assert record.error == "navigation outside the origin of the target is not allowed"
    assert response_of(record).url == "about:blank"


async def test_navigation_to_an_absolute_address_of_the_same_origin_is_allowed(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        record = await adapter.drive(browser_step("goto", url=f"{site.url}/static"))
    assert record.ok is True
    assert response_of(record).url == f"{site.url}/static"


async def test_a_step_of_another_kind_is_not_the_business_of_the_browser(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site) as adapter:
        other = HttpStep.model_validate(
            {"adapter": "http", "request": {"method": "GET", "path": "/health"}}
        )
        with pytest.raises(UnsupportedStepError):
            await adapter.drive(other)


async def test_a_flood_of_console_messages_is_cut_at_the_payload_limit(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    async with opened(runtime, site, max_payload_bytes=20_000) as adapter:
        record = await adapter.drive(browser_step("goto", url="/flood"))
    assert record.response_truncated is True
    kept = response_of(record).console
    assert 0 < len(kept) < 400
    assert len(json.dumps([m.model_dump() for m in kept], separators=(",", ":"))) <= 10_000
    assert max(len(m.text) for m in kept) <= 1000


async def test_the_session_has_no_recording_when_nothing_was_driven_yet_closed_twice(
    runtime: BrowserRuntime, site: TestSite
) -> None:
    adapter = await runtime.open_adapter(browser_context(site), new_id())
    await adapter.close()
    await adapter.close()
    assert runtime.host.active_contexts == 0
    for item in await adapter.session_artifacts():
        assert item.path.is_file()
