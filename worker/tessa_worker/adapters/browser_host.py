import asyncio
import contextlib
import logging
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from playwright.async_api import Browser, BrowserContext, Playwright, async_playwright
from playwright.async_api import Error as PlaywrightError

from tessa_api.ids import new_id
from tessa_api.schemas.common import Viewport
from tessa_worker.adapters.browser_processes import (
    BrowserLayout,
    OwnerIdentity,
    ProcessProbe,
    ProcessRegistry,
    SweepReport,
    SystemProcessProbe,
    TrackedProcess,
    sweep_strays,
)
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.adapters.browser_host")

LAUNCH_TIMEOUT_SECONDS = 30.0
CONNECT_TIMEOUT_SECONDS = 20.0
ENDPOINT_POLL_SECONDS = 0.05
CONTEXT_CLOSE_TIMEOUT_SECONDS = 10.0
GRACEFUL_EXIT_SECONDS = 3.0
PROFILE_REMOVE_ATTEMPTS = 5
PROFILE_REMOVE_PAUSE_SECONDS = 0.3
DEVTOOLS_PORT_FILE = "DevToolsActivePort"
SCRATCH_NAME_LENGTH = 12
SCRATCH_MAX_AGE_SECONDS = 2 * 60 * 60
WINDOWS_NEW_PROCESS_GROUP = 0x00000200
CHROMIUM_FLAGS = (
    "--disable-field-trial-config",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-back-forward-cache",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--force-color-profile=srgb",
    "--metrics-recording-only",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-service-autorun",
    "--disable-search-engine-choice-screen",
    "--disable-infobars",
    "--mute-audio",
    "--hide-scrollbars",
)


class BrowserLaunchError(Exception):
    pass


@dataclass(frozen=True)
class BrowserHostConfig:
    max_contexts: int
    headless: bool
    data_dir: Path

    @classmethod
    def from_settings(cls, settings: WorkerSettings) -> "BrowserHostConfig":
        return cls(
            max_contexts=settings.browser_max_contexts,
            headless=settings.browser_headless,
            data_dir=settings.data_dir,
        )


def chromium_arguments(executable: str, profile: Path, headless: bool, as_root: bool) -> list[str]:
    arguments = [
        executable,
        f"--user-data-dir={profile}",
        "--remote-debugging-port=0",
        *CHROMIUM_FLAGS,
    ]
    if headless:
        arguments.append("--headless=new")
    if sys.platform != "win32":
        arguments.append("--disable-dev-shm-usage")
    if as_root:
        arguments.append("--no-sandbox")
    arguments.append("about:blank")
    return arguments


def running_as_root() -> bool:
    return sys.platform != "win32" and os.geteuid() == 0


def parse_devtools_port_file(content: str) -> str | None:
    lines = content.strip().splitlines()
    if len(lines) < 2 or not lines[0].isdigit() or not lines[1].startswith("/"):
        return None
    return f"ws://127.0.0.1:{lines[0]}{lines[1]}"


class ContextLease:
    def __init__(self, host: "BrowserHost", context: BrowserContext, launch: int) -> None:
        self.context = context
        self.launch = launch
        self._host = host
        self._released = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        await self._host.close_lease(self)


class BrowserHost:
    def __init__(
        self,
        config: BrowserHostConfig,
        probe: ProcessProbe | None = None,
        executable: str | None = None,
    ) -> None:
        self._config = config
        self._probe = probe or SystemProcessProbe()
        self._executable = executable
        self._layout = BrowserLayout.under(config.data_dir)
        self._owner = OwnerIdentity(os.getpid(), self._probe.start_time(os.getpid()) or 0)
        self._registry = ProcessRegistry(self._layout, self._owner)
        self._semaphore = asyncio.Semaphore(config.max_contexts)
        self._launch_lock = asyncio.Lock()
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._profile: str | None = None
        self._started: int | None = None
        self._leases: set[ContextLease] = set()
        self._closers: set[asyncio.Task[None]] = set()
        self._unhealthy = False
        self._opening = 0
        self.launches = 0

    @property
    def active_contexts(self) -> int:
        return len(self._leases)

    @property
    def browser_pid(self) -> int | None:
        return None if self._process is None else self._process.pid

    @property
    def layout(self) -> BrowserLayout:
        return self._layout

    @property
    def owner(self) -> OwnerIdentity:
        return self._owner

    async def start(self) -> SweepReport:
        report = await asyncio.to_thread(sweep_strays, self._layout, self._probe, self._owner)
        if self._playwright is None:
            self._playwright = await async_playwright().start()
        return report

    async def stop(self) -> None:
        await asyncio.gather(
            *(lease.release() for lease in tuple(self._leases)), return_exceptions=True
        )
        if self._closers:
            await asyncio.gather(*tuple(self._closers), return_exceptions=True)
        async with self._launch_lock:
            await self._discard_browser()
        playwright, self._playwright = self._playwright, None
        if playwright is not None:
            with contextlib.suppress(PlaywrightError, OSError):
                await playwright.stop()
        await asyncio.to_thread(shutil.rmtree, self._layout.scratch_of(self._owner), True)
        self._registry.delete()

    def scratch_for(self, session_id: UUID) -> Path:
        return self._layout.scratch_of(self._owner) / session_id.hex[:SCRATCH_NAME_LENGTH]

    async def acquire(self, viewport: Viewport) -> ContextLease:
        await asyncio.to_thread(self._prune_scratch)
        await self._semaphore.acquire()
        self._opening += 1
        try:
            browser = await self._ensure_browser()
            context = await browser.new_context(
                viewport={"width": viewport.width, "height": viewport.height}
            )
        except BaseException:
            self._semaphore.release()
            raise
        finally:
            self._opening -= 1
        lease = ContextLease(self, context, self.launches)
        self._leases.add(lease)
        return lease

    def _prune_scratch(self) -> None:
        root = self._layout.scratch_of(self._owner)
        if not root.is_dir():
            return
        now = time.time()
        for folder in root.iterdir():
            if not folder.is_dir():
                continue
            empty = not any(folder.iterdir())
            stale = now - folder.stat().st_mtime > SCRATCH_MAX_AGE_SECONDS
            if empty or stale:
                shutil.rmtree(folder, ignore_errors=True)

    async def close_lease(self, lease: ContextLease) -> None:
        closer = asyncio.create_task(self._close_context(lease))
        self._closers.add(closer)
        closer.add_done_callback(self._closers.discard)
        await asyncio.shield(closer)

    async def _close_context(self, lease: ContextLease) -> None:
        try:
            async with asyncio.timeout(CONTEXT_CLOSE_TIMEOUT_SECONDS):
                await lease.context.close()
        except (PlaywrightError, TimeoutError):
            logger.warning("browser_context_close_failed")
            self._unhealthy = self._unhealthy or lease.launch == self.launches
        finally:
            self._leases.discard(lease)
            self._semaphore.release()
            if self._unhealthy and not self._leases and self._opening == 0:
                await self._restart_unhealthy_browser()

    async def _restart_unhealthy_browser(self) -> None:
        async with self._launch_lock:
            if self._unhealthy and not self._leases and self._opening == 0:
                self._unhealthy = False
                await self._discard_browser()

    async def _ensure_browser(self) -> Browser:
        async with self._launch_lock:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            await self._discard_browser()
            self._browser = await self._launch()
            return self._browser

    async def _launch(self) -> Browser:
        playwright = self._playwright
        if playwright is None:
            raise BrowserLaunchError("the browser host was not started")
        executable = self._executable or playwright.chromium.executable_path
        profile_name = new_id().hex[:SCRATCH_NAME_LENGTH]
        profile = self._layout.profiles / profile_name
        profile.mkdir(parents=True, exist_ok=True)
        process = await self._spawn(executable, profile)
        self._process = process
        self._profile = profile_name
        self._started = self._probe.start_time(process.pid)
        self._registry.record(TrackedProcess(process.pid, self._started or 0, profile_name))
        try:
            endpoint = await self._wait_for_endpoint(profile, process)
            async with asyncio.timeout(CONNECT_TIMEOUT_SECONDS):
                browser = await playwright.chromium.connect_over_cdp(endpoint)
        except BaseException:
            await self._discard_browser()
            raise
        browser.on("disconnected", lambda _: self._on_browser_disconnected(browser))
        self.launches += 1
        return browser

    async def _spawn(self, executable: str, profile: Path) -> asyncio.subprocess.Process:
        arguments = chromium_arguments(
            executable, profile, self._config.headless, running_as_root()
        )
        if sys.platform == "win32":
            return await asyncio.create_subprocess_exec(
                *arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=WINDOWS_NEW_PROCESS_GROUP,
            )
        return await asyncio.create_subprocess_exec(
            *arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

    async def _wait_for_endpoint(self, profile: Path, process: asyncio.subprocess.Process) -> str:
        port_file = profile / DEVTOOLS_PORT_FILE
        try:
            async with asyncio.timeout(LAUNCH_TIMEOUT_SECONDS):
                while True:
                    if process.returncode is not None:
                        raise BrowserLaunchError(
                            f"the browser exited with code {process.returncode} while starting"
                        )
                    endpoint = await asyncio.to_thread(read_endpoint, port_file)
                    if endpoint is not None:
                        return endpoint
                    await asyncio.sleep(ENDPOINT_POLL_SECONDS)
        except TimeoutError as error:
            raise BrowserLaunchError("the browser did not open its debugging port") from error

    def _on_browser_disconnected(self, browser: Browser) -> None:
        if self._browser is browser:
            self._browser = None

    async def _discard_browser(self) -> None:
        browser, self._browser = self._browser, None
        process, self._process = self._process, None
        profile, self._profile = self._profile, None
        started, self._started = self._started, None
        if browser is not None:
            await self._ask_browser_to_close(browser)
        if process is not None:
            await self._reap(process, started)
        if process is not None and profile is not None:
            removed = await self._remove_profile(profile)
            self._registry.release(process.pid, removed)

    async def _ask_browser_to_close(self, browser: Browser) -> None:
        try:
            async with asyncio.timeout(GRACEFUL_EXIT_SECONDS):
                session = await browser.new_browser_cdp_session()
                await session.send("Browser.close")
        except (PlaywrightError, TimeoutError):
            logger.debug("browser_graceful_close_failed")

    async def _reap(self, process: asyncio.subprocess.Process, started: int | None) -> None:
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(GRACEFUL_EXIT_SECONDS):
                await process.wait()
        if process.returncode is not None:
            return
        if started is None or self._probe.start_time(process.pid) == started:
            await asyncio.to_thread(self._probe.kill_tree, process.pid)
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(GRACEFUL_EXIT_SECONDS):
                await process.wait()

    async def _remove_profile(self, profile_name: str) -> bool:
        target = self._layout.profiles / profile_name
        for _ in range(PROFILE_REMOVE_ATTEMPTS):
            await asyncio.to_thread(shutil.rmtree, target, True)
            if not target.exists():
                return True
            await asyncio.sleep(PROFILE_REMOVE_PAUSE_SECONDS)
        return False


def read_endpoint(port_file: Path) -> str | None:
    try:
        return parse_devtools_port_file(port_file.read_text(encoding="utf-8"))
    except OSError:
        return None
