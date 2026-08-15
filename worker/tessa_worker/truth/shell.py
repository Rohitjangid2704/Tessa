import os
import shutil
from collections.abc import Iterator, Mapping
from pathlib import Path

WINDOWS_LAUNCHER_FOLDERS = ("system32", "windowsapps")
GIT_BASH_RELATIVE_PATHS = (Path("bin") / "bash.exe", Path("usr") / "bin" / "bash.exe")
GIT_INSTALL_FOLDERS = ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432")
GIT_USER_INSTALL = Path("Programs") / "Git"


def is_windows_launcher(path: Path) -> bool:
    return any(part.lower() in WINDOWS_LAUNCHER_FOLDERS for part in path.parts)


def path_candidates(search_path: str) -> Iterator[Path]:
    for folder in search_path.split(os.pathsep):
        if folder:
            yield Path(folder) / "bash.exe"


def git_roots(environment: Mapping[str, str]) -> Iterator[Path]:
    git = shutil.which("git", path=environment.get("PATH"))
    if git is not None:
        yield Path(git).resolve().parent.parent
    for variable in GIT_INSTALL_FOLDERS:
        base = environment.get(variable)
        if base:
            yield Path(base) / "Git"
    local = environment.get("LOCALAPPDATA")
    if local:
        yield Path(local) / GIT_USER_INSTALL


def windows_bash_candidates(environment: Mapping[str, str]) -> Iterator[Path]:
    for candidate in path_candidates(environment.get("PATH", "")):
        if not is_windows_launcher(candidate):
            yield candidate
    for root in git_roots(environment):
        for relative in GIT_BASH_RELATIVE_PATHS:
            yield root / relative


def locate_bash(environment: Mapping[str, str] | None = None) -> str | None:
    variables = os.environ if environment is None else environment
    if os.name != "nt":
        return shutil.which("bash", path=variables.get("PATH"))
    for candidate in windows_bash_candidates(variables):
        if candidate.is_file():
            return str(candidate)
    return None


def bash_path_entries(bash: str) -> list[str]:
    executable = Path(bash)
    root = executable.parent.parent
    if executable.parent.name.lower() == "bin" and root.name.lower() == "usr":
        root = root.parent
    unix_tools = root / "usr" / "bin"
    return [str(unix_tools)] if os.name == "nt" and unix_tools.is_dir() else []
