from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, SeedRow
from tessa_api.schemas.bundle import BundleManifest


def declares_seed_material(manifest: BundleManifest) -> bool:
    seeds = manifest.seeds
    return seeds is not None and (seeds.reset_script is not None or seeds.hash_command is not None)


def parse_stored_manifest(bundle: BundleRow) -> BundleManifest | None:
    if bundle.manifest is None:
        return None
    try:
        return BundleManifest.model_validate(bundle.manifest)
    except ValidationError:
        return None


async def seed_in_force(session: AsyncSession, bundle: BundleRow) -> SeedRow | None:
    manifest = parse_stored_manifest(bundle)
    if manifest is None or not declares_seed_material(manifest):
        return None
    return await session.scalar(
        select(SeedRow)
        .join(BundleRow, BundleRow.id == SeedRow.bundle_id)
        .where(SeedRow.target_id == bundle.target_id, BundleRow.version <= bundle.version)
        .order_by(SeedRow.version.desc())
        .limit(1)
    )
