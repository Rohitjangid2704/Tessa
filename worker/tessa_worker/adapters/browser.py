import asyncio
import contextlib
import logging
import time
import zipfile
from collections.abc import Awaitable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Locator, Page, ScreencastSize

from tessa_api.schemas.common import Viewport
from tessa_api.schemas.enums import AdapterKind, ArtifactKind, HealthCheckStatus
from tessa_api.schemas.health import HealthState
from tessa_api.schemas.scenario import (
    BrowserStep,
    BrowserTarget,
    DomStateExpect,
    ScenarioStep,
)
from tessa_api.schemas.steps import (
    BrowserStepRequest,
    BrowserStepResponse,
    ConsoleMessage,
    DomStateObservation,
    ElementState,
)
from tessa_worker.adapters.accessibility import ACCESSIBILITY_KEY, AccessibilityScanner
from tessa_worker.adapters.base import ProducedArtifact, StepRecord, TargetTrace
from tessa_worker.adapters.browser_artifacts import redact_trace_archive
from tessa_worker.adapters.browser_host import BrowserHost, BrowserHostConfig, ContextLease
from tessa_worker.adapters.browser_processes import SweepReport
from tessa_worker.adapters.browser_steps import (
    StepFailure,
    console_message,
    exact_selector,
    navigation_url,
    normalise_text,
    page_shows,
    partial_selector,
    request_action,
    same_origin,
    step_label,
)
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.errors import AdapterError, MissingPlaceholderError
from tessa_worker.adapters.payload import fit_items, json_size
from tessa_worker.checks.page_checks import dom_failures
from tessa_worker.live.frame_pump import FramePump, PumpLimits
from tessa_worker.live.uplink import FrameUplink
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.adapters.browser")

DEFAULT_VIEWPORT = Viewport(width=1280, height=720)
ACTION_TIMEOUT_SECONDS = 15.0
NAVIGATION_TIMEOUT_SECONDS = 30.0
SETTLE_TIMEOUT_SECONDS = 15.0
SETTLE_POLL_SECONDS = 0.1
OBSERVE_TIMEOUT_SECONDS = 2.0
SCREENSHOT_TIMEOUT_SECONDS = 10.0
CLOSE_STEP_TIMEOUT_SECONDS = 15.0
EXCERPT_CHARS = 2000
CONSOLE_TEXT_CHARS = 1000
ERROR_CHARS = 300
FAVICON_PATTERN = "**/favicon.ico"
RECORDING_NAME = "recording.webm"
RECORDING_MIME = "video/webm"
SCREENSHOT_MIME = "image/png"
TRACE_MIME = "application/zip"
MAX_RECORDING_EDGE = 1280


class UnsupportedStepError(AdapterError):
    pass


def first_line(text: str) -> str:
    return text.strip().splitlines()[0] if text.strip() else ""


def recording_size(viewport: Viewport) -> ScreencastSize:
    scale = min(1.0, MAX_RECORDING_EDGE / max(viewport.width, viewport.height))
    return ScreencastSize(width=int(viewport.width * scale), height=int(viewport.height * scale))


class BrowserAdapter:
    kind = AdapterKind.browser

    def __init__(
        self,
        context: AdapterContext,
        lease: ContextLease,
        page: Page,
        session_id: UUID,
        scratch: Path,
        viewport: Viewport,
        scan_accessibility: bool = False,
    ) -> None:
        self.viewport = viewport
        self.session_id = session_id
        self.pump: FramePump | None = None
        self._accessibility = AccessibilityScanner(self._redact) if scan_accessibility else None
        self._context = context
        self._lease = lease
        self._page = page
        self._scratch = scratch
        self._console: list[ConsoleMessage] = []
        self._step_index = 0
        self._tracing = False
        self._chunk_open = False
        self._recording = False
        self._closed = False
        self._action_timeout = min(ACTION_TIMEOUT_SECONDS, context.limits.step_timeout_seconds)
        self._settle_timeout = min(SETTLE_TIMEOUT_SECONDS, context.limits.step_timeout_seconds)
        self._navigation_timeout = min(
            NAVIGATION_TIMEOUT_SECONDS, context.limits.step_timeout_seconds
        )

    @property
    def page(self) -> Page:
        return self._page

    @property
    def recording_path(self) -> Path:
        return self._scratch / RECORDING_NAME

    async def begin(self, uplink: FrameUplink | None, limits: PumpLimits) -> None:
        self._scratch.mkdir(parents=True, exist_ok=True)
        page = self._page
        page.set_default_timeout(self._action_timeout * 1000)
        page.set_default_navigation_timeout(self._navigation_timeout * 1000)
        page.on("console", lambda message: self._remember(message.type, message.text))
        page.on("pageerror", lambda error: self._remember("error", error.message))
        await page.context.route(FAVICON_PATTERN, lambda route: route.fulfill(status=204))
        await page.context.tracing.start(screenshots=True, snapshots=True)
        self._tracing = True
        try:
            await page.screencast.start(
                path=str(self.recording_path), size=recording_size(self.viewport)
            )
            self._recording = True
        except PlaywrightError:
            logger.warning("browser_recording_unavailable", extra={"session": str(self.session_id)})
        if uplink is not None:
            self.pump = await FramePump.attach(self.session_id, page.context, page, uplink, limits)

    async def drive(self, step: ScenarioStep) -> StepRecord:
        if not isinstance(step, BrowserStep):
            raise UnsupportedStepError(f"the browser adapter cannot drive a {step.adapter} step")
        index = self._step_index
        self._step_index += 1
        label = self._redact(step_label(step))
        started_at = datetime.now(UTC)
        started = time.monotonic()
        self._console.clear()
        await self._start_chunk(label)
        error: str | None = None
        navigated_to: str | None = None
        try:
            navigated_to = await self._perform(step)
            await self._settle(step)
        except StepFailure as failure:
            error = str(failure)
        except MissingPlaceholderError as missing:
            error = str(missing)
        except PlaywrightError as failure:
            error = first_line(str(failure))
        latency_ms = int((time.monotonic() - started) * 1000)
        response, truncated = await self._observe(step.expect.dom_state)
        response = await self._with_accessibility(step, response, error is None)
        artifacts = [
            *await self._screenshot(index),
            *await self._stop_chunk(index),
        ]
        return StepRecord(
            adapter=AdapterKind.browser,
            label=label,
            request=BrowserStepRequest(
                kind="browser",
                action=request_action(step),
                target=None if step.target is None else self._redact(step.target.key()),
                text=None if step.value is None else self._redact(step.value),
                url=None if navigated_to is None else self._redact(navigated_to),
            ),
            response=response,
            response_truncated=truncated,
            ok=error is None,
            error=None if error is None else self._redact(error)[:ERROR_CHARS],
            latency_ms=latency_ms,
            artifacts=artifacts,
            started_at=started_at,
            finished_at=datetime.now(UTC),
        )

    async def trace(self, trace_id: str) -> TargetTrace | None:
        return None

    async def health(self) -> HealthState:
        started = time.monotonic()
        try:
            async with asyncio.timeout(OBSERVE_TIMEOUT_SECONDS):
                await self._page.evaluate("1")
        except (PlaywrightError, TimeoutError):
            return HealthState(
                status=HealthCheckStatus.failed,
                checked_at=datetime.now(UTC),
                latency_ms=None,
                message="the page does not respond",
            )
        return HealthState(
            status=HealthCheckStatus.ok,
            checked_at=datetime.now(UTC),
            latency_ms=int((time.monotonic() - started) * 1000),
            message=None,
        )

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self.pump is not None:
                await self._guarded(self.pump.close())
            if self._tracing:
                await self._guarded(self._page.context.tracing.stop())
            if self._recording:
                await self._guarded(self._page.screencast.stop())
        finally:
            await self._lease.release()

    async def session_artifacts(self) -> Sequence[ProducedArtifact]:
        path = self.recording_path
        if not self._recording or not path.is_file() or path.stat().st_size == 0:
            return []
        return [ProducedArtifact(kind=ArtifactKind.recording, mime=RECORDING_MIME, path=path)]

    def _redact(self, text: str) -> str:
        return self._context.redactor.redact_text(text)

    def _remember(self, playwright_type: str, text: str) -> None:
        shortened = text[:CONSOLE_TEXT_CHARS]
        self._console.append(console_message(playwright_type, self._redact(shortened)))

    async def _guarded(self, work: Awaitable[object]) -> None:
        try:
            async with asyncio.timeout(CLOSE_STEP_TIMEOUT_SECONDS):
                await work
        except (PlaywrightError, TimeoutError):
            logger.warning("browser_close_step_failed", extra={"session": str(self.session_id)})

    async def _perform(self, step: BrowserStep) -> str | None:
        if step.action == "goto":
            return await self._goto(step)
        if step.action == "wait_for":
            return None
        value = self._context.environment.substitute(step.value) if step.value is not None else ""
        timeout_ms = self._action_timeout * 1000
        if step.action == "press" and step.target is None:
            await self._page.keyboard.press(value)
            return None
        locator = await self._locate(step)
        if step.action == "click":
            await locator.click(timeout=timeout_ms)
        elif step.action == "hover":
            await locator.hover(timeout=timeout_ms)
        elif step.action == "check":
            await locator.check(timeout=timeout_ms)
        elif step.action == "fill":
            await locator.fill(value, timeout=timeout_ms)
        elif step.action == "select":
            await locator.select_option(value, timeout=timeout_ms)
        else:
            await locator.press(value, timeout=timeout_ms)
        return None

    async def _goto(self, step: BrowserStep) -> str:
        wanted = self._context.environment.substitute(step.url or "")
        address = navigation_url(self._context.interface.base_url, wanted)
        if not same_origin(address, self._context.interface.origin):
            raise StepFailure("navigation outside the origin of the target is not allowed")
        await self._page.goto(address, wait_until="load", timeout=self._navigation_timeout * 1000)
        return address

    async def _locate(self, step: BrowserStep) -> Locator:
        if step.target is None:
            raise StepFailure(f"the {step.action} step has no target")
        return await self._resolve(step.target)

    async def _resolve(self, target: BrowserTarget, include_hidden: bool = False) -> Locator:
        exact = self._page.locator(exact_selector(target, include_hidden))
        partial = partial_selector(target, include_hidden)
        if partial is None or await exact.count() > 0:
            return exact
        return self._page.locator(partial)

    async def _settle(self, step: BrowserStep) -> None:
        expectation = step.expect.dom_state
        if expectation is None:
            with contextlib.suppress(PlaywrightError):
                await self._page.wait_for_load_state(
                    "domcontentloaded", timeout=self._action_timeout * 1000
                )
            return
        deadline = time.monotonic() + self._settle_timeout
        while True:
            response, _ = await self._observe(expectation)
            if not dom_failures(response, expectation):
                return
            if time.monotonic() >= deadline:
                if step.action == "wait_for":
                    raise StepFailure("the page did not reach the expected state in time")
                return
            await asyncio.sleep(SETTLE_POLL_SECONDS)

    async def _observe(
        self, expectation: DomStateExpect | None
    ) -> tuple[BrowserStepResponse, bool]:
        page = self._page
        title = await self._attempt(page.title())
        page_text = await self._attempt(
            page.inner_text("body", timeout=OBSERVE_TIMEOUT_SECONDS * 1000)
        )
        excerpt = None
        if page_text is not None:
            excerpt = self._redact(page_text.strip())[:EXCERPT_CHARS]
        kept, truncated = fit_items(
            self._console,
            lambda message: json_size(message.model_dump(mode="json")),
            self._context.limits.max_payload_bytes // 2,
        )
        dom_state = None
        if expectation is not None:
            dom_state = await self._dom_observation(expectation, page_text or "")
        response = BrowserStepResponse(
            kind="browser",
            url=self._redact(page.url),
            title=None if title is None else self._redact(title),
            text_excerpt=excerpt,
            console=list(kept),
            dom_state=dom_state,
        )
        return response, truncated

    async def _with_accessibility(
        self, step: BrowserStep, response: BrowserStepResponse, completed: bool
    ) -> BrowserStepResponse:
        scanner = self._accessibility
        url = self._page.url
        if scanner is None or not completed or not scanner.due(url, step.action == "goto"):
            return response
        capture = await scanner.scan(self._page, url)
        if capture is None:
            return response
        return BrowserStepResponse.model_validate(
            {**response.model_dump(mode="json"), ACCESSIBILITY_KEY: capture.model_dump(mode="json")}
        )

    async def _dom_observation(
        self, expectation: DomStateExpect, page_text: str
    ) -> DomStateObservation:
        normalised = normalise_text(page_text)
        texts = [*expectation.text_contains, *expectation.text_not_contains]
        elements: dict[str, ElementState] = {}
        for target in [*expectation.visible, *expectation.hidden]:
            elements[target.key()] = await self._element_state(target)
        return DomStateObservation(
            text_found={text: page_shows(normalised, text) for text in texts}, elements=elements
        )

    async def _element_state(self, target: BrowserTarget) -> ElementState:
        try:
            async with asyncio.timeout(OBSERVE_TIMEOUT_SECONDS):
                locator = await self._resolve(target, include_hidden=True)
                if await locator.count() == 0:
                    return "missing"
                return "visible" if await locator.filter(visible=True).count() > 0 else "hidden"
        except (PlaywrightError, TimeoutError):
            return "missing"

    async def _attempt(self, work: Awaitable[str]) -> str | None:
        try:
            async with asyncio.timeout(OBSERVE_TIMEOUT_SECONDS + 1):
                return await work
        except (PlaywrightError, TimeoutError):
            return None

    async def _start_chunk(self, label: str) -> None:
        if not self._tracing:
            return
        try:
            await self._page.context.tracing.start_chunk(title=label)
            self._chunk_open = True
        except PlaywrightError:
            logger.warning("browser_trace_chunk_failed", extra={"session": str(self.session_id)})

    async def _stop_chunk(self, index: int) -> list[ProducedArtifact]:
        if not self._chunk_open:
            return []
        self._chunk_open = False
        path = self._scratch / f"t{index}.zip"
        try:
            await self._page.context.tracing.stop_chunk(path=str(path))
        except PlaywrightError:
            return []
        if not path.is_file():
            return []
        try:
            await asyncio.to_thread(redact_trace_archive, path, self._context.redactor)
        except (zipfile.BadZipFile, OSError):
            logger.warning("browser_trace_unreadable", extra={"session": str(self.session_id)})
            path.unlink(missing_ok=True)
            return []
        return [ProducedArtifact(kind=ArtifactKind.trace, mime=TRACE_MIME, path=path)]

    async def _screenshot(self, index: int) -> list[ProducedArtifact]:
        path = self._scratch / f"s{index}.png"
        try:
            await self._page.screenshot(
                path=str(path), type="png", timeout=SCREENSHOT_TIMEOUT_SECONDS * 1000
            )
        except PlaywrightError:
            return []
        return [ProducedArtifact(kind=ArtifactKind.screenshot, mime=SCREENSHOT_MIME, path=path)]


class BrowserRuntime:
    def __init__(
        self,
        settings: WorkerSettings,
        uplink: FrameUplink | None = None,
        host: BrowserHost | None = None,
        scan_accessibility: bool = True,
    ) -> None:
        self.host = host or BrowserHost(BrowserHostConfig.from_settings(settings))
        self.uplink = uplink
        self._pump_limits = PumpLimits.from_settings(settings)
        self._scan_accessibility = scan_accessibility

    async def start(self) -> SweepReport:
        report = await self.host.start()
        if self.uplink is not None:
            await self.uplink.start()
        return report

    async def stop(self) -> None:
        if self.uplink is not None:
            await self.uplink.stop()
        await self.host.stop()

    async def open_adapter(
        self,
        context: AdapterContext,
        session_id: UUID,
        viewport: Viewport = DEFAULT_VIEWPORT,
    ) -> BrowserAdapter:
        lease = await self.host.acquire(viewport)
        try:
            page = await lease.context.new_page()
        except BaseException:
            await lease.release()
            raise
        adapter = BrowserAdapter(
            context,
            lease,
            page,
            session_id,
            self.host.scratch_for(session_id),
            viewport,
            self._scan_accessibility,
        )
        try:
            await adapter.begin(self.uplink, self._pump_limits)
        except BaseException:
            await adapter.close()
            raise
        return adapter
