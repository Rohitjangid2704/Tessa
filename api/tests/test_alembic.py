import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command
from tessa_api.settings import Settings
from tests.support import alembic_config

pytestmark = pytest.mark.integration

EXPECTED_TABLES = {
    "alembic_version",
    "browser_sessions",
    "bundles",
    "catalog_items",
    "coverage_cells",
    "environments",
    "idempotency_keys",
    "judge_results",
    "labels",
    "oracle_results",
    "oracle_templates",
    "plans",
    "probe_results",
    "prompt_issues",
    "prompt_templates",
    "run_events",
    "run_scenarios",
    "runs",
    "scenarios",
    "seeds",
    "settings",
    "steps",
    "targets",
    "users",
}


def inspect_database(settings: Settings) -> tuple[set[str], set[str]]:
    async def run() -> tuple[set[str], set[str]]:
        engine = create_async_engine(settings.database_url.get_secret_value())
        async with engine.connect() as connection:
            tables = await connection.execute(
                text("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
            )
            extensions = await connection.execute(text("SELECT extname FROM pg_extension"))
            names: tuple[set[str], set[str]] = (set(tables.scalars()), set(extensions.scalars()))
        await engine.dispose()
        return names

    return asyncio.run(run())


def test_round_trip_upgrade_check_downgrade_upgrade(
    settings: Settings, migrated_database: None
) -> None:
    config = alembic_config(settings)
    try:
        command.upgrade(config, "head")
        command.check(config)
        tables, extensions = inspect_database(settings)
        assert tables >= EXPECTED_TABLES
        assert {"vector", "citext"} <= extensions

        command.downgrade(config, "base")
        tables, _ = inspect_database(settings)
        assert tables.isdisjoint(EXPECTED_TABLES - {"alembic_version"})

        command.upgrade(config, "head")
        command.check(config)
    finally:
        command.upgrade(config, "head")


def test_models_match_the_migration_after_upgrade(
    settings: Settings, migrated_database: None
) -> None:
    command.check(alembic_config(settings))
