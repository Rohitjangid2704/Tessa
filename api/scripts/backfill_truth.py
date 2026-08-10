import argparse
import asyncio
import sys
import uuid

from sqlalchemy import select

from tessa_api.db.models import BundleRow
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.schemas.enums import BundleValidationStatus
from tessa_api.services.storage import bundle_store_from_settings
from tessa_api.services.truth_backfill import BackfillReport, backfill_target
from tessa_api.settings import load_settings


async def run(target_id: uuid.UUID | None) -> BackfillReport:
    settings = load_settings()
    store = bundle_store_from_settings(settings)
    engine = create_engine(settings.database_url)
    scanned = unreadable = seeds_created = oracles_created = 0
    try:
        session_factory = create_session_factory(engine)
        async with session_factory() as session:
            statement = select(BundleRow.target_id).where(
                BundleRow.validation_status == BundleValidationStatus.valid
            )
            if target_id is not None:
                statement = statement.where(BundleRow.target_id == target_id)
            target_ids = sorted((await session.scalars(statement.distinct())).all())
        for current in target_ids:
            async with session_factory() as session:
                report = await backfill_target(
                    session, store, current, settings.bundle_max_file_bytes
                )
            scanned += report.bundles_scanned
            unreadable += report.bundles_unreadable
            seeds_created += report.seeds_created
            oracles_created += report.oracles_created
    finally:
        await engine.dispose()
    return BackfillReport(scanned, unreadable, seeds_created, oracles_created)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Import seeds and oracle templates of bundles accepted before the truth import"
    )
    parser.add_argument("--target-id", type=uuid.UUID, default=None)
    arguments = parser.parse_args()
    report = asyncio.run(run(arguments.target_id))
    sys.stdout.write(
        f"scanned {report.bundles_scanned} bundles, {report.bundles_unreadable} unreadable, "
        f"created {report.seeds_created} seeds and {report.oracles_created} oracle templates\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
