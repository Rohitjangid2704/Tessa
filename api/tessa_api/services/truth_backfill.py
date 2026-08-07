import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, SeedRow
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import BundleValidationStatus
from tessa_api.services.bundle_intake import LOCK_KEY_PREFIX, LOCK_STATEMENT
from tessa_api.services.storage import BundleStore
from tessa_api.services.truth_import import SEEDS_FOLDER, import_truth

ORACLE_PREFIX = "oracle/"


@dataclass(frozen=True, slots=True)
class BackfillReport:
    bundles_scanned: int
    bundles_unreadable: int
    seeds_created: int
    oracles_created: int


async def read_truth_files(
    store: BundleStore, bundle: BundleRow, max_file_bytes: int
) -> dict[str, bytes] | None:
    if bundle.storage_path is None:
        return None
    files: dict[str, bytes] = {}
    for entry in bundle.files:
        path = str(entry["path"])
        if not path.startswith((SEEDS_FOLDER, ORACLE_PREFIX)):
            continue
        content = await store.read(bundle.storage_path, path, max_file_bytes)
        if content is None:
            return None
        files[path] = content
    return files


async def latest_seed_bundle_version(session: AsyncSession, target_id: uuid.UUID) -> int:
    version = await session.scalar(
        select(func.max(BundleRow.version))
        .join(SeedRow, SeedRow.bundle_id == BundleRow.id)
        .where(SeedRow.target_id == target_id)
    )
    return version or 0


async def backfill_target(
    session: AsyncSession, store: BundleStore, target_id: uuid.UUID, max_file_bytes: int
) -> BackfillReport:
    await session.execute(LOCK_STATEMENT, {"key": f"{LOCK_KEY_PREFIX}{target_id}"})
    seeded_through = await latest_seed_bundle_version(session, target_id)
    bundles = (
        await session.scalars(
            select(BundleRow)
            .where(
                BundleRow.target_id == target_id,
                BundleRow.validation_status == BundleValidationStatus.valid,
                BundleRow.manifest.is_not(None),
            )
            .order_by(BundleRow.version)
        )
    ).all()
    unreadable = seeds_created = oracles_created = 0
    for bundle in bundles:
        files = await read_truth_files(store, bundle, max_file_bytes)
        if files is None or bundle.manifest is None:
            unreadable += 1
            continue
        imported = await import_truth(
            session,
            bundle,
            BundleManifest.model_validate(bundle.manifest),
            files,
            include_seed=bundle.version > seeded_through,
        )
        seeds_created += int(imported.seed_created)
        oracles_created += imported.oracles_created
    await session.commit()
    return BackfillReport(len(bundles), unreadable, seeds_created, oracles_created)
