import subprocess
import sys
import time

from tessa_worker.adapters.browser_processes import SystemProcessProbe

WINDOWS_QUERY = (
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'chrome*' -and "
    "$_.CommandLine -like '*%s*' } "
    "| ForEach-Object { $_.ProcessId }"
)
WINDOWS_CPU_QUERY = (
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in %s } "
    "| ForEach-Object { $_.UserModeTime + $_.KernelModeTime }"
)
WINDOWS_TIME_UNIT_SECONDS = 1e-7
SHELL_TIMEOUT_SECONDS = 90


def pids_with_command_line(fragment: str) -> list[int]:
    if sys.platform == "win32":
        command = ["powershell", "-NoProfile", "-Command", WINDOWS_QUERY % fragment]
    else:
        command = ["pgrep", "-f", fragment]
    result = subprocess.run(
        command, capture_output=True, text=True, check=False, timeout=SHELL_TIMEOUT_SECONDS
    )
    return [int(line) for line in result.stdout.split() if line.strip().isdigit()]


def cpu_seconds_of(pids: list[int]) -> float | None:
    if sys.platform != "win32" or not pids:
        return None
    listed = "@(" + ",".join(str(pid) for pid in pids) + ")"
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", WINDOWS_CPU_QUERY % listed],
        capture_output=True,
        text=True,
        check=False,
        timeout=SHELL_TIMEOUT_SECONDS,
    )
    ticks = [int(line) for line in result.stdout.split() if line.strip().isdigit()]
    return sum(ticks) * WINDOWS_TIME_UNIT_SECONDS


def wait_until_gone(pid: int, patience_seconds: float = 20.0) -> bool:
    probe = SystemProcessProbe()
    deadline = time.monotonic() + patience_seconds
    while time.monotonic() < deadline:
        if probe.start_time(pid) is None:
            return True
        time.sleep(0.1)
    return False
