import re
from pathlib import Path

from tessa_api.settings import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
API_ROOT = REPO_ROOT / "api"
DEV_SCRIPT = REPO_ROOT / "deploy" / "dev.ps1"
API_ARGUMENTS = re.compile(r'"uvicorn", "tessa_api\.main:app",(?P<rest>[^)]*)\)', re.DOTALL)


def api_arguments() -> list[str]:
    found = API_ARGUMENTS.search(DEV_SCRIPT.read_text(encoding="utf-8"))
    assert found is not None
    return re.findall(r'"([^"]+)"', found.group("rest"))


def option_values(arguments: list[str], option: str) -> list[str]:
    return [arguments[index + 1] for index, value in enumerate(arguments) if value == option]


def test_the_dev_api_reloads_only_on_changes_to_the_package() -> None:
    arguments = api_arguments()
    assert "--reload" in arguments
    watched = [(API_ROOT / folder).resolve() for folder in option_values(arguments, "--reload-dir")]
    assert watched == [(API_ROOT / "tessa_api").resolve()]


def test_the_data_directory_of_the_dev_api_is_outside_the_watched_package() -> None:
    data_dir = (API_ROOT / Settings(_env_file=API_ROOT / ".env.example").data_dir).resolve()
    for folder in option_values(api_arguments(), "--reload-dir"):
        assert not data_dir.is_relative_to((API_ROOT / folder).resolve())


def test_a_reload_cannot_wait_forever_on_open_streams() -> None:
    [seconds] = option_values(api_arguments(), "--timeout-graceful-shutdown")
    assert 0 < int(seconds) <= 30
