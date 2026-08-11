from pathlib import Path

import pytest

from tessa_api.services.storage import StorageKey
from tessa_api.services.storage_local import (
    PARTIAL_SUFFIX,
    REPLACE_ATTEMPTS,
    LocalStorage,
    partial_path_of,
)

WINDOWS_MAX_PATH = 260
NEAR_LIMIT_PATH_LENGTH = 250


class FlakyReplace:
    def __init__(self, failures: int) -> None:
        self.failures = failures
        self.calls = 0
        self.original = Path.replace

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def replace(origin: Path, target: Path) -> Path:
            self.calls += 1
            if self.calls <= self.failures:
                raise PermissionError(5, "Access is denied", str(origin))
            return self.original(origin, target)

        monkeypatch.setattr(Path, "replace", replace)


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr("tessa_api.services.storage_local.time.sleep", slept.append)
    return slept


def staged_bundle(root: Path) -> LocalStorage:
    staging = root / "bundles" / "target" / ".staging-1"
    (staging / "seeds").mkdir(parents=True)
    (staging / "seeds" / "hash.py").write_text("print('x')\n", encoding="utf-8")
    (staging / "manifest.yaml").write_text("app: {}\n", encoding="utf-8")
    return LocalStorage(root)


def test_a_staging_folder_held_briefly_by_another_process_is_still_committed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]
) -> None:
    storage = staged_bundle(tmp_path)
    flaky = FlakyReplace(failures=3)
    flaky.install(monkeypatch)
    moved = storage.move_prefix_sync(
        StorageKey("bundles/target/.staging-1"), StorageKey("bundles/target/1")
    )
    assert moved == 2
    assert (tmp_path / "bundles" / "target" / "1" / "seeds" / "hash.py").is_file()
    assert not (tmp_path / "bundles" / "target" / ".staging-1").exists()
    assert flaky.calls == 4
    assert len(no_sleep) == 3


def test_a_folder_that_stays_locked_fails_after_the_last_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]
) -> None:
    storage = staged_bundle(tmp_path)
    FlakyReplace(failures=REPLACE_ATTEMPTS).install(monkeypatch)
    with pytest.raises(PermissionError):
        storage.move_prefix_sync(
            StorageKey("bundles/target/.staging-1"), StorageKey("bundles/target/1")
        )
    assert len(no_sleep) == REPLACE_ATTEMPTS - 1
    assert (tmp_path / "bundles" / "target" / ".staging-1" / "manifest.yaml").is_file()


def test_a_put_survives_a_brief_lock_on_its_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]
) -> None:
    storage = LocalStorage(tmp_path)
    FlakyReplace(failures=2).install(monkeypatch)
    stored = storage.put_sync(StorageKey("artifacts/run/step.png"), b"\x89PNG", "image/png")
    assert stored.size_bytes == 4
    assert (tmp_path / "artifacts" / "run" / "step.png").read_bytes() == b"\x89PNG"
    assert not list((tmp_path / "artifacts" / "run").glob("*.partial"))


def test_the_partial_file_sits_beside_the_target_and_does_not_lengthen_its_path() -> None:
    final = Path("bundles", "target", ".staging-abc", "flows", "create_maintenance_issue.yaml")
    partial = partial_path_of(final)
    assert partial.parent == final.parent
    assert partial.name.endswith(PARTIAL_SUFFIX)
    assert len(partial.name) <= len(".0123456789ab") + len(PARTIAL_SUFFIX)
    assert partial_path_of(final) != partial


async def test_a_file_whose_final_path_fits_windows_max_path_can_be_written(
    tmp_path: Path,
) -> None:
    storage = LocalStorage(tmp_path)
    folder = tmp_path / "bundles"
    room = NEAR_LIMIT_PATH_LENGTH - len(str(folder)) - len("/.yaml")
    name = f"{'n' * max(room, 1)}.yaml"
    key = StorageKey(f"bundles/{name}")
    assert len(str(folder / name)) < WINDOWS_MAX_PATH
    stored = await storage.put(key, b"scenario: body\n")
    assert stored.size_bytes == len(b"scenario: body\n")
    assert await storage.get(key) == b"scenario: body\n"
    assert [item.key async for item in storage.list_prefix(StorageKey("bundles"))] == [key]
