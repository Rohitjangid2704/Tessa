import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tessa_worker.adapters.browser_processes import (
    BrowserLayout,
    OwnerIdentity,
    ProcessRegistry,
    SystemProcessProbe,
    TrackedProcess,
    linux_start_time,
    read_registry,
    sweep_strays,
)

CURRENT = OwnerIdentity(pid=4000, started=40)
DEAD_OWNER = OwnerIdentity(pid=5000, started=50)
LIVE_OWNER = OwnerIdentity(pid=6000, started=60)
SLEEPER = "import time; time.sleep(120)"
PARENT_WITH_CHILD = (
    "import subprocess, sys, time\n"
    f"child = subprocess.Popen([sys.executable, '-c', {SLEEPER!r}])\n"
    "print(child.pid, flush=True)\n"
    "time.sleep(120)\n"
)


class FakeProbe:
    def __init__(self, alive: dict[int, int]) -> None:
        self.alive = dict(alive)
        self.killed: list[int] = []

    def start_time(self, pid: int) -> int | None:
        return self.alive.get(pid)

    def kill_tree(self, pid: int) -> None:
        self.killed.append(pid)
        self.alive.pop(pid, None)


@pytest.fixture
def layout(tmp_path: Path) -> BrowserLayout:
    return BrowserLayout.under(tmp_path)


def make_profile(layout: BrowserLayout, name: str) -> Path:
    profile = layout.profiles / name
    (profile / "Default").mkdir(parents=True)
    (profile / "Default" / "Cookies").write_text("x", encoding="utf-8")
    return profile


def register(
    layout: BrowserLayout,
    owner: OwnerIdentity,
    processes: list[TrackedProcess],
) -> ProcessRegistry:
    registry = ProcessRegistry(layout, owner)
    for process in processes:
        registry.record(process)
    return registry


def wait_until_gone(pid: int, probe: SystemProcessProbe, patience: float = 10.0) -> bool:
    deadline = time.monotonic() + patience
    while time.monotonic() < deadline:
        if probe.start_time(pid) is None:
            return True
        time.sleep(0.05)
    return False


def test_the_registry_file_is_named_after_its_owner_and_lists_the_browsers(
    layout: BrowserLayout,
) -> None:
    register(layout, CURRENT, [TrackedProcess(11, 110, "aaa"), TrackedProcess(12, 120, "bbb")])
    path = layout.owner_file(CURRENT)
    assert path.name == "4000-40.json"
    owner, processes, leftovers = read_registry(path) or (None, [], [])
    assert owner == CURRENT
    assert [(item.pid, item.started, item.profile) for item in processes] == [
        (11, 110, "aaa"),
        (12, 120, "bbb"),
    ]
    assert leftovers == []


def test_releasing_a_browser_keeps_a_profile_that_could_not_be_removed(
    layout: BrowserLayout,
) -> None:
    registry = register(layout, CURRENT, [TrackedProcess(11, 110, "aaa")])
    registry.release(11, profile_removed=False)
    parsed = read_registry(layout.owner_file(CURRENT))
    assert parsed is not None
    assert parsed[1] == []
    assert parsed[2] == ["aaa"]
    registry.delete()
    assert layout.owner_file(CURRENT).exists()


def test_the_registry_file_goes_away_when_nothing_is_left_to_clean(layout: BrowserLayout) -> None:
    registry = register(layout, CURRENT, [TrackedProcess(11, 110, "aaa")])
    registry.release(11, profile_removed=True)
    registry.delete()
    assert not layout.owner_file(CURRENT).exists()


def test_an_unreadable_registry_is_reported_as_such(layout: BrowserLayout) -> None:
    layout.owners.mkdir(parents=True)
    broken = layout.owners / "1-1.json"
    broken.write_text("{not json", encoding="utf-8")
    assert read_registry(broken) is None
    broken.write_text(json.dumps({"owner": {"pid": "x"}}), encoding="utf-8")
    assert read_registry(broken) is None


def test_the_browser_of_a_dead_worker_is_killed_with_its_profile_and_registry(
    layout: BrowserLayout,
) -> None:
    profile = make_profile(layout, "stray")
    register(layout, DEAD_OWNER, [TrackedProcess(77, 770, "stray")])
    scratch = layout.scratch_of(DEAD_OWNER) / "session"
    scratch.mkdir(parents=True)
    probe = FakeProbe({77: 770, CURRENT.pid: CURRENT.started})
    report = sweep_strays(layout, probe, CURRENT)
    assert probe.killed == [77]
    assert report.killed == [77]
    assert not profile.exists()
    assert not layout.scratch_of(DEAD_OWNER).exists()
    assert not layout.owner_file(DEAD_OWNER).exists()
    assert report.registries_removed == 1


def test_the_browser_of_a_live_worker_is_left_alone(layout: BrowserLayout) -> None:
    profile = make_profile(layout, "busy")
    register(layout, LIVE_OWNER, [TrackedProcess(88, 880, "busy")])
    probe = FakeProbe({88: 880, LIVE_OWNER.pid: LIVE_OWNER.started})
    report = sweep_strays(layout, probe, CURRENT)
    assert probe.killed == []
    assert profile.exists()
    assert layout.owner_file(LIVE_OWNER).exists()
    assert report.registries_removed == 0


def test_a_recycled_owner_pid_does_not_protect_the_browser(layout: BrowserLayout) -> None:
    register(layout, DEAD_OWNER, [TrackedProcess(77, 770, "stray")])
    make_profile(layout, "stray")
    probe = FakeProbe({DEAD_OWNER.pid: 999999, 77: 770})
    sweep_strays(layout, probe, CURRENT)
    assert probe.killed == [77]


def test_a_recycled_browser_pid_is_never_killed(layout: BrowserLayout) -> None:
    profile = make_profile(layout, "stray")
    register(layout, DEAD_OWNER, [TrackedProcess(77, 770, "stray")])
    probe = FakeProbe({77: 123456})
    sweep_strays(layout, probe, CURRENT)
    assert probe.killed == []
    assert not profile.exists()
    assert not layout.owner_file(DEAD_OWNER).exists()


def test_the_current_worker_is_never_swept(layout: BrowserLayout) -> None:
    register(layout, CURRENT, [TrackedProcess(66, 660, "mine")])
    make_profile(layout, "mine")
    probe = FakeProbe({66: 660})
    sweep_strays(layout, probe, CURRENT)
    assert probe.killed == []
    assert layout.owner_file(CURRENT).exists()


def test_leftover_profiles_of_a_dead_worker_are_removed(layout: BrowserLayout) -> None:
    registry = register(layout, DEAD_OWNER, [TrackedProcess(77, 770, "gone")])
    registry.release(77, profile_removed=False)
    profile = make_profile(layout, "gone")
    sweep_strays(layout, FakeProbe({}), CURRENT)
    assert not profile.exists()
    assert not layout.owner_file(DEAD_OWNER).exists()


def test_a_corrupt_registry_is_deleted(layout: BrowserLayout) -> None:
    layout.owners.mkdir(parents=True)
    broken = layout.owners / "9-9.json"
    broken.write_text("???", encoding="utf-8")
    report = sweep_strays(layout, FakeProbe({}), CURRENT)
    assert not broken.exists()
    assert report.registries_removed == 1


def test_a_profile_name_that_climbs_out_of_the_profiles_folder_is_not_followed(
    layout: BrowserLayout, tmp_path: Path
) -> None:
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("x", encoding="utf-8")
    register(layout, DEAD_OWNER, [TrackedProcess(77, 770, "../../victim")])
    sweep_strays(layout, FakeProbe({}), CURRENT)
    assert (victim / "keep.txt").exists()
    assert layout.owner_file(DEAD_OWNER).exists()


def test_without_any_registry_the_sweep_does_nothing(layout: BrowserLayout) -> None:
    report = sweep_strays(layout, FakeProbe({}), CURRENT)
    assert report.registries_removed == 0
    assert report.killed == []


def test_the_system_probe_knows_this_process_and_not_a_missing_one() -> None:
    probe = SystemProcessProbe()
    first = probe.start_time(os.getpid())
    assert first is not None
    assert probe.start_time(os.getpid()) == first
    assert probe.start_time(0) is None
    assert probe.start_time(-4) is None
    assert probe.start_time(2**22 + 12345) is None


def test_killing_a_tree_takes_the_children_with_it() -> None:
    probe = SystemProcessProbe()
    parent = subprocess.Popen(
        [sys.executable, "-c", PARENT_WITH_CHILD], stdout=subprocess.PIPE, text=True
    )
    try:
        assert parent.stdout is not None
        child_pid = int(parent.stdout.readline())
        assert probe.start_time(child_pid) is not None
        probe.kill_tree(parent.pid)
        parent.wait(timeout=10)
        assert wait_until_gone(child_pid, probe)
    finally:
        if parent.poll() is None:
            parent.kill()


def test_a_real_stray_is_killed_and_an_unrelated_process_survives(layout: BrowserLayout) -> None:
    probe = SystemProcessProbe()
    stray = subprocess.Popen([sys.executable, "-c", SLEEPER])
    bystander = subprocess.Popen([sys.executable, "-c", SLEEPER])
    finished_owner = subprocess.Popen([sys.executable, "-c", "pass"])
    try:
        finished_owner.wait(timeout=10)
        started = probe.start_time(stray.pid)
        assert started is not None
        profile = make_profile(layout, "real")
        register(
            layout,
            OwnerIdentity(finished_owner.pid, 1),
            [TrackedProcess(stray.pid, started, "real")],
        )
        report = sweep_strays(layout, probe, OwnerIdentity(os.getpid(), 1))
        stray.wait(timeout=10)
        assert report.killed == [stray.pid]
        assert not profile.exists()
        assert bystander.poll() is None
    finally:
        for process in (stray, bystander):
            if process.poll() is None:
                process.kill()


def test_the_start_time_is_read_from_the_proc_stat_line(tmp_path: Path) -> None:
    folder = tmp_path / "321"
    folder.mkdir()
    fields_after_name = ["S", "1"] + ["0"] * 17 + ["987654"] + ["0"] * 20
    (folder / "stat").write_text(
        "321 (odd) name) " + " ".join(fields_after_name) + "\n", encoding="utf-8"
    )
    assert linux_start_time(321, tmp_path) == 987654


def test_a_zombie_or_missing_process_has_no_start_time(tmp_path: Path) -> None:
    folder = tmp_path / "322"
    folder.mkdir()
    fields_after_name = ["Z", "1"] + ["0"] * 17 + ["55"] + ["0"] * 20
    (folder / "stat").write_text("322 (x) " + " ".join(fields_after_name), encoding="utf-8")
    assert linux_start_time(322, tmp_path) is None
    assert linux_start_time(404, tmp_path) is None
