import asyncio
import tempfile
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath

from tessa_worker.truth.errors import SeedFailure, SeedFailureCode

WORKSPACE_PREFIX = "seed-"


def write_files(root: Path, files: Mapping[str, bytes]) -> None:
    resolved_root = root.resolve()
    for path, content in files.items():
        destination = (resolved_root / PurePosixPath(path)).resolve()
        if not destination.is_relative_to(resolved_root):
            raise SeedFailure(
                SeedFailureCode.material_missing, f"seed file path {path!r} leaves the workspace"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)


@asynccontextmanager
async def seed_workspace(files: Mapping[str, bytes]) -> AsyncIterator[Path]:
    directory = await asyncio.to_thread(
        tempfile.TemporaryDirectory, prefix=WORKSPACE_PREFIX, ignore_cleanup_errors=True
    )
    try:
        root = Path(directory.name)
        await asyncio.to_thread(write_files, root, files)
        yield root
    finally:
        await asyncio.to_thread(directory.cleanup)
