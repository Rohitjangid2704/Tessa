from collections.abc import Mapping
from dataclasses import dataclass

from tessa_api.db.models import BundleRow
from tessa_api.services.storage import BundleStore, sha256_hex
from tessa_worker.truth.errors import SeedFailure, SeedFailureCode

SEEDS_FOLDER = "seeds/"


@dataclass(frozen=True, slots=True)
class SeedFiles:
    reset_script_path: str | None
    hash_command: str | None
    dsn_env: str | None
    files: Mapping[str, bytes]


def missing_file(path: str) -> SeedFailure:
    return SeedFailure(
        SeedFailureCode.material_missing,
        f"seed file {path} is missing from the bundle store or differs from the accepted bundle",
    )


async def read_seed_files(store: BundleStore, bundle: BundleRow) -> dict[str, bytes]:
    if bundle.storage_path is None:
        raise SeedFailure(SeedFailureCode.material_missing, "the bundle has no stored files")
    files: dict[str, bytes] = {}
    for entry in bundle.files:
        path = str(entry["path"])
        if not path.startswith(SEEDS_FOLDER):
            continue
        content = await store.read(bundle.storage_path, path, int(entry["size_bytes"]) + 1)
        if content is None or sha256_hex(content) != entry["sha256"]:
            raise missing_file(path)
        files[path] = content
    return files
