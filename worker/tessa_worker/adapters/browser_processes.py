import contextlib
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

logger = logging.getLogger("tessa_worker.adapters.browser_processes")

BROWSER_FOLDER = "browser"
OWNERS_FOLDER = "owners"
PROFILES_FOLDER = "profiles"
SCRATCH_FOLDER = "scratch"
OWNER_FILE_SUFFIX = ".json"
TASKKILL_TIMEOUT_SECONDS = 15.0
EXIT_WAIT_SECONDS = 10.0
EXIT_POLL_SECONDS = 0.1
REMOVE_ATTEMPTS = 20
REMOVE_PAUSE_SECONDS = 0.25
WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
WINDOWS_STILL_ACTIVE = 259
LINUX_START_TIME_FIELD = 19


class ProcessProbe(Protocol):
    def start_time(self, pid: int) -> int | None: ...

    def kill_tree(self, pid: int) -> None: ...


def windows_start_time(pid: int) -> int | None:
    import ctypes
    from ctypes import wintypes

    class FileTime(ctypes.Structure):
        _fields_ = (("low", wintypes.DWORD), ("high", wintypes.DWORD))

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(FileTime),) * 4
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel32.OpenProcess(WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return None
        if exit_code.value != WINDOWS_STILL_ACTIVE:
            return None
        created, exited, kernel, user = FileTime(), FileTime(), FileTime(), FileTime()
        ok = kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        )
        return (created.high << 32) | created.low if ok else None
    finally:
        kernel32.CloseHandle(handle)


def linux_start_time(pid: int, proc_root: Path = Path("/proc")) -> int | None:
    try:
        content = (proc_root / str(pid) / "stat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fields = content[content.rfind(")") + 2 :].split()
    if len(fields) <= LINUX_START_TIME_FIELD or fields[0] == "Z":
        return None
    try:
        return int(fields[LINUX_START_TIME_FIELD])
    except ValueError:
        return None


class SystemProcessProbe:
    def start_time(self, pid: int) -> int | None:
        if pid <= 0:
            return None
        if sys.platform == "win32":
            return windows_start_time(pid)
        return linux_start_time(pid)

    def kill_tree(self, pid: int) -> None:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                check=False,
                timeout=TASKKILL_TIMEOUT_SECONDS,
            )
            return
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)


@dataclass(frozen=True, slots=True)
class OwnerIdentity:
    pid: int
    started: int

    @property
    def key(self) -> str:
        return f"{self.pid}-{self.started}"


@dataclass(frozen=True, slots=True)
class TrackedProcess:
    pid: int
    started: int
    profile: str


@dataclass(slots=True)
class SweepReport:
    registries_removed: int = 0
    killed: list[int] = field(default_factory=list)
    profiles_removed: list[str] = field(default_factory=list)
    scratch_removed: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class BrowserLayout:
    root: Path

    @classmethod
    def under(cls, data_dir: Path) -> "BrowserLayout":
        return cls(data_dir / BROWSER_FOLDER)

    @property
    def owners(self) -> Path:
        return self.root / OWNERS_FOLDER

    @property
    def profiles(self) -> Path:
        return self.root / PROFILES_FOLDER

    @property
    def scratch(self) -> Path:
        return self.root / SCRATCH_FOLDER

    def scratch_of(self, owner: OwnerIdentity) -> Path:
        return self.scratch / owner.key

    def owner_file(self, owner: OwnerIdentity) -> Path:
        return self.owners / f"{owner.key}{OWNER_FILE_SUFFIX}"


class ProcessRegistry:
    def __init__(self, layout: BrowserLayout, owner: OwnerIdentity) -> None:
        self._layout = layout
        self._owner = owner
        self._processes: dict[int, TrackedProcess] = {}
        self._leftover_profiles: set[str] = set()

    def record(self, process: TrackedProcess) -> None:
        self._processes[process.pid] = process
        self._write()

    def release(self, pid: int, profile_removed: bool) -> None:
        process = self._processes.pop(pid, None)
        if process is not None and not profile_removed:
            self._leftover_profiles.add(process.profile)
        self._write()

    def delete(self) -> None:
        if self._processes or self._leftover_profiles:
            return
        with contextlib.suppress(OSError):
            self._layout.owner_file(self._owner).unlink(missing_ok=True)

    def _write(self) -> None:
        self._layout.owners.mkdir(parents=True, exist_ok=True)
        target = self._layout.owner_file(self._owner)
        document = {
            "owner": {"pid": self._owner.pid, "started": self._owner.started},
            "chromium": [
                {"pid": item.pid, "started": item.started, "profile": item.profile}
                for item in self._processes.values()
            ],
            "leftover_profiles": sorted(self._leftover_profiles),
        }
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(document), encoding="utf-8")
        temporary.replace(target)


def read_registry(path: Path) -> tuple[OwnerIdentity, list[TrackedProcess], list[str]] | None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        owner = OwnerIdentity(int(document["owner"]["pid"]), int(document["owner"]["started"]))
        processes = [
            TrackedProcess(int(item["pid"]), int(item["started"]), str(item["profile"]))
            for item in document.get("chromium", [])
        ]
        leftovers = [str(item) for item in document.get("leftover_profiles", [])]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return owner, processes, leftovers


def remove_inside(
    base: Path,
    name: str,
    attempts: int = REMOVE_ATTEMPTS,
    pause_seconds: float = REMOVE_PAUSE_SECONDS,
) -> bool:
    target = (base / name).resolve()
    if not target.is_relative_to(base.resolve()) or target == base.resolve():
        return False
    for attempt in range(attempts):
        shutil.rmtree(target, ignore_errors=True)
        if not target.exists():
            return True
        if attempt + 1 < attempts:
            time.sleep(pause_seconds)
    return False


def wait_for_exit(probe: ProcessProbe, process: TrackedProcess) -> None:
    deadline = time.monotonic() + EXIT_WAIT_SECONDS
    while probe.start_time(process.pid) == process.started and time.monotonic() < deadline:
        time.sleep(EXIT_POLL_SECONDS)


def sweep_strays(layout: BrowserLayout, probe: ProcessProbe, current: OwnerIdentity) -> SweepReport:
    report = SweepReport()
    if not layout.owners.is_dir():
        return report
    for path in sorted(layout.owners.glob(f"*{OWNER_FILE_SUFFIX}")):
        parsed = read_registry(path)
        if parsed is None:
            path.unlink(missing_ok=True)
            report.registries_removed += 1
            continue
        owner, processes, leftovers = parsed
        if owner == current or probe.start_time(owner.pid) == owner.started:
            continue
        everything_removed = True
        for process in processes:
            if probe.start_time(process.pid) == process.started:
                logger.warning("stray_browser_killed", extra={"pid": process.pid})
                probe.kill_tree(process.pid)
                wait_for_exit(probe, process)
                report.killed.append(process.pid)
        for profile in [*(process.profile for process in processes), *leftovers]:
            if remove_inside(layout.profiles, profile):
                report.profiles_removed.append(profile)
            else:
                everything_removed = False
        if remove_inside(layout.scratch, owner.key):
            report.scratch_removed.append(owner.key)
        else:
            everything_removed = False
        if everything_removed:
            path.unlink(missing_ok=True)
            report.registries_removed += 1
    return report
