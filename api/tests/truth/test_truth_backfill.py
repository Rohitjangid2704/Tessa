import subprocess
import sys
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete

from tessa_api.db.models import OracleTemplateRow, SeedRow
from tessa_api.services.storage import LocalBundleStore
from tessa_api.services.truth_backfill import BackfillReport, backfill_target
from tessa_api.settings import Settings
from tests.support import API_ROOT
from tests.test_scripts import script_environment
from tests.truth.support import (
    gracie_files,
    oracle_rows,
    seed_rows,
    upload_files,
    with_reset_script_edit,
)

pytestmark = pytest.mark.integration


async def upload_versions(
    client: httpx.AsyncClient, headers: dict[str, str], token: str, count: int
) -> None:
    changes = [(), (with_reset_script_edit,)]
    for position in range(count):
        response = await upload_files(client, headers, gracie_files(token, *changes[position]))
        assert response.status_code == 201, response.text


async def forget_truth(app: FastAPI, *, seeds: bool = True, oracles: bool = True) -> None:
    async with app.state.session_factory() as session:
        if oracles:
            await session.execute(delete(OracleTemplateRow))
        if seeds:
            await session.execute(delete(SeedRow))
        await session.commit()


async def backfill(app: FastAPI, settings: Settings, target_id: str) -> BackfillReport:
    async with app.state.session_factory() as session:
        return await backfill_target(
            session,
            LocalBundleStore(settings.data_dir),
            uuid.UUID(target_id),
            settings.bundle_max_file_bytes,
        )


async def test_the_backfill_restores_what_bundles_accepted_before_the_import_would_have_created(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    settings: Settings,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_versions(client, member_headers, token, 2)
    await forget_truth(db_app)
    report = await backfill(db_app, settings, target["id"])
    assert report == BackfillReport(
        bundles_scanned=2, bundles_unreadable=0, seeds_created=2, oracles_created=2
    )
    assert [seed.version for seed in await seed_rows(db_app, target["id"])] == [1, 2]
    assert len(await oracle_rows(db_app, target["id"])) == 2


async def test_running_the_backfill_again_creates_nothing(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    settings: Settings,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_versions(client, member_headers, token, 2)
    await forget_truth(db_app)
    await backfill(db_app, settings, target["id"])
    before = [(seed.id, seed.version) for seed in await seed_rows(db_app, target["id"])]
    again = await backfill(db_app, settings, target["id"])
    assert (again.seeds_created, again.oracles_created) == (0, 0)
    assert [(seed.id, seed.version) for seed in await seed_rows(db_app, target["id"])] == before


async def test_the_backfill_does_not_re_import_seeds_older_than_the_latest_seed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    settings: Settings,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_versions(client, member_headers, token, 2)
    async with db_app.state.session_factory() as session:
        await session.execute(delete(SeedRow).where(SeedRow.version == 1))
        await session.commit()
    report = await backfill(db_app, settings, target["id"])
    assert (report.seeds_created, report.oracles_created) == (0, 0)
    assert [seed.version for seed in await seed_rows(db_app, target["id"])] == [2]


async def test_a_bundle_whose_files_are_gone_is_counted_and_skipped(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    settings: Settings,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_versions(client, member_headers, token, 1)
    await forget_truth(db_app)
    for path in (settings.data_dir / "bundles").rglob("reset.sql"):
        path.unlink()
    report = await backfill(db_app, settings, target["id"])
    assert report == BackfillReport(
        bundles_scanned=1, bundles_unreadable=1, seeds_created=0, oracles_created=0
    )


async def test_the_script_backfills_and_is_idempotent(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    settings: Settings,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_versions(client, member_headers, token, 1)
    await forget_truth(db_app)
    environment = {**script_environment(), "TESSA_DATA_DIR": str(settings.data_dir)}

    def run() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "scripts/backfill_truth.py", "--target-id", target["id"]],
            cwd=API_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    first = run()
    assert first.returncode == 0, first.stderr
    assert "created 1 seeds and 1 oracle templates" in first.stdout
    second = run()
    assert second.returncode == 0, second.stderr
    assert "created 0 seeds and 0 oracle templates" in second.stdout
    assert len(await seed_rows(db_app, target["id"])) == 1
