import asyncio
import json
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tessa_api.ids import new_id
from tessa_api.schemas.common import Viewport
from tessa_api.schemas.scenario import BrowserStep
from tessa_worker.adapters.browser import BrowserRuntime
from tessa_worker.adapters.browser_host import (
    BrowserHost,
    BrowserHostConfig,
    BrowserLaunchError,
    chromium_arguments,
    parse_devtools_port_file,
)
from tessa_worker.adapters.browser_processes import SystemProcessProbe, read_registry
from tessa_worker.settings import WorkerSettings
from tests.browser_site.site import TestSite
from tests.live.conftest import browser_context
from tests.live.process_support import pids_with_command_line, wait_until_gone
from tests.live.support import eventually

pytestmark = pytest.mark.browser

VIEWPORT = Viewport(width=800, height=600)
WORKER_ROOT = Path(__file__).resolve().parents[2]


def browser_step(action: str, **fields: object) -> BrowserStep:
    return BrowserStep.model_validate({"adapter": "browser", "action": action, **fields})


def config_for(data_dir: Path, max_contexts: int = 2) -> BrowserHostConfig:
    return BrowserHostConfig(max_contexts=max_contexts, headless=True, data_dir=data_dir)


def spawn_host_child(data_dir: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "tests.live.host_child", str(data_dir)],
        cwd=WORKER_ROOT,
        stdout=subprocess.PIPE,
        text=True,
    )


def spawn_sleeper() -> subprocess.Popen[bytes]:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])


async def announced_browser_pid(child: subprocess.Popen[str]) -> int:
    assert child.stdout is not None
    line = await asyncio.to_thread(child.stdout.readline)
    return int(json.loads(line)["browser_pid"])


@pytest.fixture
async def host(tmp_path: Path) -> AsyncIterator[BrowserHost]:
    started = BrowserHost(config_for(tmp_path))
    await started.start()
    yield started
    await started.stop()


def test_the_debugging_port_file_names_the_websocket_endpoint() -> None:
    assert parse_devtools_port_file("51234\n/devtools/browser/abc-123\n") == (
        "ws://127.0.0.1:51234/devtools/browser/abc-123"
    )


@pytest.mark.parametrize("content", ["", "51234", "abc\n/devtools/browser/x", "5\nnot-a-path"])
def test_an_incomplete_port_file_is_not_an_endpoint(content: str) -> None:
    assert parse_devtools_port_file(content) is None


def test_the_launch_arguments_use_a_private_profile_and_the_headless_flag(tmp_path: Path) -> None:
    headless = chromium_arguments("chrome", tmp_path, headless=True, as_root=False)
    headed = chromium_arguments("chrome", tmp_path, headless=False, as_root=False)
    assert headless[0] == "chrome"
    assert f"--user-data-dir={tmp_path}" in headless
    assert "--remote-debugging-port=0" in headless
    assert "--headless=new" in headless
    assert "--headless=new" not in headed
    assert "--no-sandbox" not in headless
    assert "--no-sandbox" in chromium_arguments("chrome", tmp_path, headless=True, as_root=True)
    assert headless[-1] == "about:blank"


async def test_acquiring_before_the_host_started_is_an_error_and_frees_the_slot(
    tmp_path: Path,
) -> None:
    unstarted = BrowserHost(config_for(tmp_path, max_contexts=1))
    with pytest.raises(BrowserLaunchError, match="was not started"):
        await unstarted.acquire(VIEWPORT)
    with pytest.raises(BrowserLaunchError, match="was not started"):
        await asyncio.wait_for(unstarted.acquire(VIEWPORT), 10)
    assert unstarted.active_contexts == 0


async def test_a_lease_is_a_working_context_and_releasing_it_closes_it(host: BrowserHost) -> None:
    lease = await host.acquire(VIEWPORT)
    page = await lease.context.new_page()
    assert page.viewport_size == {"width": 800, "height": 600}
    assert host.active_contexts == 1
    await lease.release()
    assert host.active_contexts == 0
    assert page.is_closed()
    await lease.release()
    assert host.active_contexts == 0


async def test_no_more_contexts_than_the_cap_exist_at_once(host: BrowserHost) -> None:
    first = await host.acquire(VIEWPORT)
    second = await host.acquire(VIEWPORT)
    third = asyncio.create_task(host.acquire(VIEWPORT))
    await asyncio.sleep(0.5)
    assert third.done() is False
    assert host.active_contexts == 2
    await first.release()
    lease = await asyncio.wait_for(third, 30)
    assert host.active_contexts == 2
    await second.release()
    await lease.release()
    assert host.active_contexts == 0


async def test_a_waiting_acquire_that_is_cancelled_leaves_the_slot_alone(
    host: BrowserHost,
) -> None:
    first = await host.acquire(VIEWPORT)
    second = await host.acquire(VIEWPORT)
    waiting = asyncio.create_task(host.acquire(VIEWPORT))
    await asyncio.sleep(0.2)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    await first.release()
    replacement = await asyncio.wait_for(host.acquire(VIEWPORT), 30)
    await second.release()
    await replacement.release()
    assert host.active_contexts == 0


async def test_one_browser_process_serves_every_context(host: BrowserHost) -> None:
    first = await host.acquire(VIEWPORT)
    pid = host.browser_pid
    second = await host.acquire(VIEWPORT)
    assert host.browser_pid == pid
    assert host.launches == 1
    await first.release()
    await second.release()
    assert host.browser_pid == pid


async def test_the_browser_is_recorded_while_it_runs_and_removed_with_its_profile_on_stop(
    tmp_path: Path,
) -> None:
    started = BrowserHost(config_for(tmp_path, max_contexts=1))
    await started.start()
    lease = await started.acquire(VIEWPORT)
    pid = started.browser_pid
    assert pid is not None
    parsed = read_registry(started.layout.owner_file(started.owner))
    assert parsed is not None
    assert [item.pid for item in parsed[1]] == [pid]
    profile = started.layout.profiles / parsed[1][0].profile
    assert profile.is_dir()
    await lease.release()
    await started.stop()
    assert wait_until_gone(pid)
    assert not profile.exists()
    assert not started.layout.owner_file(started.owner).exists()
    assert pids_with_command_line(tmp_path.name) == []


async def test_stopping_the_host_closes_the_leases_that_are_still_open(tmp_path: Path) -> None:
    started = BrowserHost(config_for(tmp_path))
    await started.start()
    lease = await started.acquire(VIEWPORT)
    page = await lease.context.new_page()
    pid = started.browser_pid
    assert pid is not None
    await started.stop()
    assert started.active_contexts == 0
    assert page.is_closed()
    assert wait_until_gone(pid)


async def test_a_browser_that_dies_is_replaced_for_the_next_context(host: BrowserHost) -> None:
    lease = await host.acquire(VIEWPORT)
    first_pid = host.browser_pid
    assert first_pid is not None
    SystemProcessProbe().kill_tree(first_pid)
    assert wait_until_gone(first_pid)
    await lease.release()
    assert host.active_contexts == 0
    replacement = await asyncio.wait_for(host.acquire(VIEWPORT), 60)
    page = await replacement.context.new_page()
    await page.goto("about:blank")
    assert host.launches == 2
    assert host.browser_pid != first_pid
    await replacement.release()


async def test_a_dead_browser_does_not_poison_a_context_opened_on_its_replacement(
    host: BrowserHost,
) -> None:
    doomed = await host.acquire(VIEWPORT)
    first_pid = host.browser_pid
    assert first_pid is not None
    SystemProcessProbe().kill_tree(first_pid)
    await eventually(
        lambda: doomed.context.browser is None or not doomed.context.browser.is_connected()
    )
    survivor = await asyncio.wait_for(host.acquire(VIEWPORT), 60)
    await doomed.release()
    page = await survivor.context.new_page()
    await page.goto("about:blank")
    assert host.browser_pid is not None
    assert host.browser_pid != first_pid
    await survivor.release()


async def test_the_runtime_closes_the_context_when_a_step_is_cancelled(
    tmp_path: Path, worker_settings: WorkerSettings
) -> None:
    settings = worker_settings.model_copy(
        update={"data_dir": tmp_path, "browser_max_contexts": 1, "browser_headless": True}
    )
    runtime = BrowserRuntime(settings)
    await runtime.start()
    with TestSite() as site:
        try:
            adapter = await runtime.open_adapter(browser_context(site), new_id())
            await adapter.drive(browser_step("goto", url="/static"))
            waiting = browser_step(
                "wait_for", expect={"dom_state": {"text_contains": ["never appears"]}}
            )
            running = asyncio.create_task(adapter.drive(waiting))
            await asyncio.sleep(0.5)
            running.cancel()
            with pytest.raises(asyncio.CancelledError):
                await running
            await adapter.close()
            assert runtime.host.active_contexts == 0
            again = await asyncio.wait_for(
                runtime.open_adapter(browser_context(site), new_id()), 60
            )
            await again.close()
        finally:
            await runtime.stop()


async def test_the_runtime_closes_the_context_when_opening_the_adapter_fails(
    tmp_path: Path, worker_settings: WorkerSettings
) -> None:
    settings = worker_settings.model_copy(
        update={"data_dir": tmp_path, "browser_max_contexts": 1, "browser_headless": True}
    )
    runtime = BrowserRuntime(settings)
    await runtime.start()
    try:
        with TestSite() as site:
            context = browser_context(site)
        session_id = new_id()
        in_the_way = runtime.host.scratch_for(session_id)
        in_the_way.parent.mkdir(parents=True, exist_ok=True)
        in_the_way.write_text("a file where the scratch folder should be", encoding="utf-8")
        with pytest.raises(FileExistsError):
            await runtime.open_adapter(context, session_id)
        assert runtime.host.active_contexts == 0
        in_the_way.unlink()
        recovered = await asyncio.wait_for(runtime.open_adapter(context, new_id()), 60)
        await recovered.close()
    finally:
        await runtime.stop()


async def test_a_worker_that_died_hard_leaves_a_browser_that_the_next_start_kills(
    tmp_path: Path,
) -> None:
    child = spawn_host_child(tmp_path)
    try:
        stray_pid = await announced_browser_pid(child)
        probe = SystemProcessProbe()
        assert probe.start_time(stray_pid) is not None
        child.kill()
        child.wait(timeout=30)
        assert probe.start_time(stray_pid) is not None
        bystander = spawn_sleeper()
        try:
            fresh = BrowserHost(config_for(tmp_path, max_contexts=1))
            report = await fresh.start()
            try:
                assert report.killed == [stray_pid]
                assert wait_until_gone(stray_pid)
                assert len(report.profiles_removed) == 1
                assert report.registries_removed == 1
                assert bystander.poll() is None
                assert pids_with_command_line(tmp_path.name) == []
            finally:
                await fresh.stop()
        finally:
            bystander.kill()
    finally:
        if child.poll() is None:
            child.kill()


async def test_a_second_worker_does_not_touch_the_browser_of_a_live_one(tmp_path: Path) -> None:
    child = spawn_host_child(tmp_path)
    pid = 0
    try:
        pid = await announced_browser_pid(child)
        fresh = BrowserHost(config_for(tmp_path, max_contexts=1))
        report = await fresh.start()
        try:
            assert report.killed == []
            assert SystemProcessProbe().start_time(pid) is not None
        finally:
            await fresh.stop()
    finally:
        child.kill()
        child.wait(timeout=30)
        if pid:
            SystemProcessProbe().kill_tree(pid)
            assert wait_until_gone(pid)
