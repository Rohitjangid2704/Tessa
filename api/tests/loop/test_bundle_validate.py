from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from tessa_api.schemas.enums import UserRole
from tests.bundle_fixtures import (
    gracie_like,
    gracie_like_changed_zip,
    gracie_like_zip,
    missing_sections_zip,
    secret_bearing_zip,
)
from tests.loop.support import OPEN_ISSUES_ITEM, proposal_yaml
from tests.stage_one import create_target
from tests.stage_two.support import SeededTarget
from tests.support import AuthHeaders, MakeUser
from tests.zip_builder import build_zip

pytestmark = pytest.mark.integration

VALIDATE_PATH = "/api/v1/bundles/validate"
COUNTED_TABLES_QUERY = text(
    "SELECT table_name FROM information_schema.tables "
    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
    "AND table_name <> 'alembic_version' ORDER BY table_name"
)


async def table_counts(app: FastAPI) -> dict[str, int]:
    async with app.state.session_factory() as session:
        names = list((await session.scalars(COUNTED_TABLES_QUERY)).all())
        counts: dict[str, int] = {}
        for name in names:
            counted = await session.scalar(text(f'SELECT count(*) FROM "{name}"'))
            counts[name] = int(counted or 0)
        return counts


async def target_rows(app: FastAPI) -> list[dict[str, Any]]:
    async with app.state.session_factory() as session:
        rows = await session.execute(text("SELECT * FROM targets ORDER BY id"))
        return [dict(row._mapping) for row in rows]


def stored_files(app: FastAPI) -> list[str]:
    root = Path(app.state.settings.data_dir)
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())


async def validate(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    archive: bytes,
    target_id: str | None = None,
) -> httpx.Response:
    data = {"target_id": target_id} if target_id is not None else {}
    return await client.post(
        VALIDATE_PATH,
        files={"file": ("tessa.zip", archive, "application/zip")},
        data=data,
        headers=headers,
    )


class StoredState:
    def __init__(self, counts: dict[str, int], targets: list[dict[str, Any]], files: list[str]):
        self.counts = counts
        self.targets = targets
        self.files = files

    @classmethod
    async def of(cls, app: FastAPI) -> "StoredState":
        return cls(await table_counts(app), await target_rows(app), stored_files(app))

    async def assert_unchanged(self, app: FastAPI) -> None:
        assert await table_counts(app) == self.counts
        assert await target_rows(app) == self.targets
        assert stored_files(app) == self.files


async def test_a_valid_bundle_is_reported_with_its_diff_and_nothing_is_stored(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    before = await StoredState.of(db_app)
    response = await validate(client, member_headers, gracie_like_changed_zip(seeded.token))
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["validation_status"] == "valid"
    assert report["errors"] == []
    assert report["feature_count"] == 5
    assert report["diff_summary"] is not None
    assert report["proposal"] is None
    assert report["completeness"]["score"] >= report["completeness"]["bar"]
    await before.assert_unchanged(db_app)


async def test_the_first_bundle_of_a_target_has_no_diff_and_is_not_stored(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    target = await create_target(client, member_headers, name="Fresh")
    before = await StoredState.of(db_app)
    response = await validate(client, member_headers, gracie_like_zip(target["target_token"]))
    assert response.status_code == 200, response.text
    assert response.json()["validation_status"] == "valid"
    assert response.json()["diff_summary"] is None
    await before.assert_unchanged(db_app)


async def test_an_invalid_bundle_lists_its_errors_and_fixups_and_is_not_stored(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    before = await StoredState.of(db_app)
    response = await validate(client, member_headers, missing_sections_zip(seeded.token))
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["validation_status"] == "invalid"
    assert report["errors"]
    assert report["fixup_items"]
    await before.assert_unchanged(db_app)


async def test_a_bundle_with_a_secret_is_refused_and_not_stored(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    before = await StoredState.of(db_app)
    response = await validate(client, member_headers, secret_bearing_zip(seeded.token))
    assert response.status_code == 422, response.text
    assert "a1B2c3D4e5F6" not in response.text
    await before.assert_unchanged(db_app)


async def test_a_proposal_in_the_bundle_is_checked_but_not_stored(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    files = gracie_like(seeded.token)
    files["proposal.yaml"] = proposal_yaml(seeded.token).encode()
    before = await StoredState.of(db_app)
    response = await validate(client, member_headers, build_zip(files, prefix="tessa/"))
    assert response.status_code == 200, response.text
    proposal = response.json()["proposal"]
    assert proposal == {"items": 3, "errors": [], "warnings": []}
    await before.assert_unchanged(db_app)


async def test_a_broken_proposal_is_a_warning_of_a_valid_bundle(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> None:
    files = gracie_like(seeded.token)
    broken = {**OPEN_ISSUES_ITEM, "risk": "catastrophic"}
    files["proposal.yaml"] = proposal_yaml(seeded.token, broken).encode()
    response = await validate(client, member_headers, build_zip(files, prefix="tessa/"))
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["validation_status"] == "valid"
    assert report["proposal"]["items"] == 0
    assert report["proposal"]["errors"]
    assert "proposal_not_imported" in [warning["code"] for warning in report["warnings"]]


async def test_an_unknown_target_token_is_refused(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    response = await validate(client, member_headers, gracie_like_zip("tgt_" + "z" * 22))
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "target_token_unknown"


async def test_a_viewer_cannot_validate_a_bundle(
    client: httpx.AsyncClient,
    db_app: FastAPI,
    seeded: SeededTarget,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> None:
    viewer = auth_headers(await make_user(UserRole.viewer))
    response = await validate(client, viewer, gracie_like_zip(seeded.token))
    assert response.status_code == 403
