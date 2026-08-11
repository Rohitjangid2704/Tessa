import re
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from tessa_api.db.models import OracleTemplateRow, SeedRow
from tessa_api.schemas.enums import OracleApproval, OracleLanguage, SeedHashSource
from tests.bundle_fixtures import gracie_like_changed, minimal_valid
from tests.stage_one import create_target
from tests.truth.support import (
    EXPECTED_HASH,
    bundle_row,
    gracie_files,
    oracle_rows,
    seed_rows,
    upload_files,
    with_description_change,
    with_dsn_env,
    with_expected_hash,
    with_hash_command,
    with_hash_script_edit,
    with_python_oracle,
    with_reset_script_edit,
    without_expected_hash,
)

pytestmark = pytest.mark.integration

SHA256 = re.compile(r"^[0-9a-f]{64}$")


async def upload_ok(
    client: httpx.AsyncClient, headers: dict[str, str], files: dict[str, bytes]
) -> dict[str, Any]:
    response = await upload_files(client, headers, files)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def test_a_valid_bundle_creates_the_first_seed_version_and_its_oracle_template(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    uploaded = await upload_ok(client, member_headers, gracie_files(token))
    seeds = await seed_rows(db_app, target["id"])
    assert len(seeds) == 1
    seed = seeds[0]
    assert str(seed.bundle_id) == uploaded["bundle"]["id"]
    assert seed.version == 1
    assert seed.reset_script_path == "seeds/reset.sql"
    assert seed.hash_command == "bash seeds/hash.sh"
    assert seed.declared_hash is None
    assert seed.hash_source is SeedHashSource.first_reset
    assert SHA256.match(seed.material_sha256)
    assert seed.observed_hash is None
    assert seed.last_reset_at is None
    assert seed.last_reset_status is None
    assert seed.last_reset_run_id is None
    oracles = await oracle_rows(db_app, target["id"])
    assert len(oracles) == 1
    oracle = oracles[0]
    assert str(oracle.bundle_id) == uploaded["bundle"]["id"]
    assert oracle.name == "open_maintenance"
    assert oracle.feature_ids == ["smart_log.read.open_maintenance"]
    assert oracle.language is OracleLanguage.sql
    assert oracle.source.startswith("SELECT r.room_number AS room")
    assert oracle.params_schema["required"] == ["tenant_id", "today"]
    assert oracle.params_schema["properties"]["today"]["x-source"] == "clock"
    assert oracle.sentence_template.startswith("{{ rows | length }} rooms have open maintenance")
    assert oracle.read_only_verified is True
    assert oracle.approval is OracleApproval.unreviewed
    assert oracle.truth_source == "primary_db"
    assert [point["key"] for point in oracle.gold_points] == ["open_rooms", "top_room"]
    assert oracle.gold_points[0]["template"] == "{{ value }} rooms"


async def test_a_declared_expected_hash_is_the_bundle_source_of_the_seed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_ok(client, member_headers, gracie_files(token, with_expected_hash()))
    seed = (await seed_rows(db_app, target["id"]))[0]
    assert seed.declared_hash == EXPECTED_HASH
    assert seed.hash_source is SeedHashSource.bundle


async def test_an_identical_upload_creates_nothing_and_an_unrelated_change_keeps_the_seed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    first = await upload_ok(client, member_headers, gracie_files(token))
    replay = await upload_files(client, member_headers, gracie_files(token))
    assert replay.status_code == 200
    assert replay.json()["created"] is False
    assert len(await seed_rows(db_app, target["id"])) == 1
    second = await upload_ok(client, member_headers, gracie_like_changed(token))
    assert second["bundle"]["id"] != first["bundle"]["id"]
    seeds = await seed_rows(db_app, target["id"])
    assert [(seed.version, str(seed.bundle_id)) for seed in seeds] == [(1, first["bundle"]["id"])]
    oracles = await oracle_rows(db_app, target["id"])
    assert sorted(str(oracle.bundle_id) for oracle in oracles) == sorted(
        [first["bundle"]["id"], second["bundle"]["id"]]
    )
    assert {oracle.name for oracle in oracles} == {"open_maintenance"}


@pytest.mark.parametrize(
    "change",
    [
        pytest.param(with_reset_script_edit, id="reset_script_text"),
        pytest.param(with_hash_command("bash seeds/hash.sh --quiet"), id="hash_command"),
        pytest.param(with_hash_script_edit, id="script_next_to_the_hash_command"),
        pytest.param(with_expected_hash(), id="expected_hash_declared"),
        pytest.param(with_dsn_env("QA_SEED_DSN"), id="seed_connection_variable"),
    ],
)
async def test_a_change_of_the_seed_material_creates_the_next_version(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
    change: Any,
) -> None:
    await upload_ok(client, member_headers, gracie_files(token))
    second = await upload_ok(client, member_headers, gracie_files(token, change))
    seeds = await seed_rows(db_app, target["id"])
    assert [seed.version for seed in seeds] == [1, 2]
    assert str(seeds[1].bundle_id) == second["bundle"]["id"]
    assert seeds[0].material_sha256 != seeds[1].material_sha256 or (
        seeds[1].declared_hash == EXPECTED_HASH
    )


async def test_changing_or_dropping_the_declared_hash_creates_a_version_and_an_equal_one_does_not(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_ok(client, member_headers, gracie_files(token, with_expected_hash()))
    await upload_ok(
        client,
        member_headers,
        gracie_files(token, with_expected_hash(), with_description_change),
    )
    assert [seed.version for seed in await seed_rows(db_app, target["id"])] == [1]
    await upload_ok(
        client, member_headers, gracie_files(token, with_expected_hash("ffffeeeedddd0000"))
    )
    await upload_ok(client, member_headers, gracie_files(token, without_expected_hash))
    seeds = await seed_rows(db_app, target["id"])
    assert [(seed.version, seed.declared_hash, seed.hash_source) for seed in seeds] == [
        (1, EXPECTED_HASH, SeedHashSource.bundle),
        (2, "ffffeeeedddd0000", SeedHashSource.bundle),
        (3, None, SeedHashSource.first_reset),
    ]


async def test_a_hash_pinned_by_the_first_reset_survives_a_bundle_that_declares_nothing(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_ok(client, member_headers, gracie_files(token))
    async with db_app.state.session_factory() as session:
        pinned = await session.scalar(select(SeedRow).where(SeedRow.version == 1))
        assert pinned is not None
        pinned.declared_hash = "pinned0123456789"
        pinned.hash_source = SeedHashSource.first_reset
        await session.commit()
    await upload_ok(client, member_headers, gracie_files(token, with_description_change))
    seeds = await seed_rows(db_app, target["id"])
    assert [(seed.version, seed.declared_hash) for seed in seeds] == [(1, "pinned0123456789")]
    await upload_ok(client, member_headers, gracie_files(token, with_expected_hash()))
    seeds = await seed_rows(db_app, target["id"])
    assert [(seed.version, seed.declared_hash) for seed in seeds] == [
        (1, "pinned0123456789"),
        (2, EXPECTED_HASH),
    ]


async def test_going_back_to_older_seed_material_is_a_new_version(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_ok(client, member_headers, gracie_files(token))
    await upload_ok(client, member_headers, gracie_files(token, with_reset_script_edit))
    await upload_ok(client, member_headers, gracie_files(token, with_description_change))
    seeds = await seed_rows(db_app, target["id"])
    assert [seed.version for seed in seeds] == [1, 2, 3]
    assert seeds[0].material_sha256 == seeds[2].material_sha256


async def test_seed_versions_are_numbered_per_target(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    other = await create_target(client, member_headers, name="Other QA")
    await upload_ok(client, member_headers, gracie_files(token))
    await upload_ok(client, member_headers, gracie_files(str(other["target_token"])))
    assert [seed.version for seed in await seed_rows(db_app, target["id"])] == [1]
    assert [seed.version for seed in await seed_rows(db_app, other["id"])] == [1]


async def test_a_python_oracle_is_imported_but_never_proven_read_only(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    await upload_ok(client, member_headers, gracie_files(token, with_python_oracle))
    oracles = {oracle.name: oracle for oracle in await oracle_rows(db_app, target["id"])}
    assert set(oracles) == {"open_maintenance", "python_count"}
    assert oracles["python_count"].language is OracleLanguage.python
    assert oracles["python_count"].read_only_verified is False
    assert oracles["python_count"].source == "def run(params, connect):\n    return []\n"
    assert oracles["python_count"].gold_points == []
    assert oracles["open_maintenance"].read_only_verified is True


async def test_an_invalid_bundle_imports_nothing(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    broken = gracie_files(token)
    broken["oracle/open_maintenance.sql"] = b"DELETE FROM room"
    response = await upload_files(client, member_headers, broken)
    assert response.status_code == 201
    assert response.json()["bundle"]["validation_status"] == "invalid"
    assert await seed_rows(db_app, target["id"]) == []
    assert await oracle_rows(db_app, target["id"]) == []


async def test_a_bundle_without_seed_material_creates_no_seed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    response = await upload_files(client, member_headers, minimal_valid(token))
    assert response.status_code == 201
    assert response.json()["bundle"]["validation_status"] == "valid"
    assert await seed_rows(db_app, target["id"]) == []
    assert await oracle_rows(db_app, target["id"]) == []


async def test_the_truth_rows_are_written_in_the_transaction_of_the_bundle(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    target: dict[str, Any],
    token: str,
) -> None:
    uploaded = await upload_ok(client, member_headers, gracie_files(token))
    row = await bundle_row(db_app, uploaded["bundle"]["id"])
    async with db_app.state.session_factory() as session:
        seeds = await session.scalar(
            select(func.count()).select_from(SeedRow).where(SeedRow.bundle_id == row.id)
        )
        oracles = await session.scalar(
            select(func.count())
            .select_from(OracleTemplateRow)
            .where(OracleTemplateRow.bundle_id == row.id)
        )
    assert (seeds, oracles) == (1, 1)
    assert uuid.UUID(target["id"]) == row.target_id
