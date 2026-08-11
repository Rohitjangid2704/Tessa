import uuid
from collections.abc import Callable
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy import select

from tessa_api.db.models import BundleRow, OracleTemplateRow, SeedRow
from tests.bundle_fixtures import Files, edit, gracie_like, mutate_manifest
from tests.bundles.support import upload_zip
from tests.zip_builder import build_zip

EXPECTED_HASH = "9f2c1d8e7b6a5d4c"
PYTHON_ORACLE_SOURCE = "def run(params, connect):\n    return []\n"
PYTHON_ORACLE_SIDECAR = """name: python_count
feature_ids: [smart_log.read.open_maintenance]
language: python
truth_source: primary_db
params_schema:
  type: object
  properties:
    tenant_id:
      type: string
      x-source: tenant
  required: [tenant_id]
sentence_template: "{{ rows | length }} rows"
"""


def with_expected_hash(value: str = EXPECTED_HASH) -> Callable[[Files], Files]:
    def apply(files: Files) -> Files:
        return mutate_manifest(
            files, lambda document: document["seeds"].update(expected_hash=value)
        )

    return apply


def without_expected_hash(files: Files) -> Files:
    def drop(document: dict[str, Any]) -> None:
        document["seeds"].pop("expected_hash", None)

    return mutate_manifest(files, drop)


def with_python_oracle(files: Files) -> Files:
    updated = dict(files)
    updated["oracle/python_count.yaml"] = PYTHON_ORACLE_SIDECAR.encode("utf-8")
    updated["oracle/python_count.py"] = PYTHON_ORACLE_SOURCE.encode("utf-8")
    return updated


def with_reset_script_edit(files: Files) -> Files:
    return edit(files, "seeds/reset.sql", "QA Hotel", "QA Hotel Two")


def with_hash_command(command: str) -> Callable[[Files], Files]:
    def apply(files: Files) -> Files:
        return edit(
            files, "manifest.yaml", "hash_command: bash seeds/hash.sh", f"hash_command: {command}"
        )

    return apply


def with_hash_script_edit(files: Files) -> Files:
    return edit(files, "seeds/hash.sh", "qa-property-1", "qa-property-2")


def with_dsn_env(name: str) -> Callable[[Files], Files]:
    def apply(files: Files) -> Files:
        edited = edit(files, "manifest.yaml", "dsn_env: SEED_DB_DSN", f"dsn_env: {name}")
        edited = edit(edited, "manifest.yaml", "  - name: SEED_DB_DSN\n", f"  - name: {name}\n")
        return edit(edited, "env.template", "SEED_DB_DSN=", f"{name}=")

    return apply


def with_description_change(files: Files) -> Files:
    return edit(
        files, "manifest.yaml", "A QA property with 40 rooms", "A QA property with 41 rooms"
    )


def gracie_files(token: str, *changes: Callable[[Files], Files]) -> Files:
    files = gracie_like(token)
    for change in changes:
        files = change(files)
    return files


async def upload_files(
    client: httpx.AsyncClient, headers: dict[str, str], files: Files, key: str | None = None
) -> httpx.Response:
    return await upload_zip(client, headers, build_zip(files, prefix="tessa/"), key=key)


async def seed_rows(app: FastAPI, target_id: str) -> list[SeedRow]:
    async with app.state.session_factory() as session:
        return list(
            (
                await session.scalars(
                    select(SeedRow)
                    .where(SeedRow.target_id == uuid.UUID(target_id))
                    .order_by(SeedRow.version)
                )
            ).all()
        )


async def oracle_rows(app: FastAPI, target_id: str) -> list[OracleTemplateRow]:
    async with app.state.session_factory() as session:
        return list(
            (
                await session.scalars(
                    select(OracleTemplateRow)
                    .where(OracleTemplateRow.target_id == uuid.UUID(target_id))
                    .order_by(OracleTemplateRow.name, OracleTemplateRow.bundle_id)
                )
            ).all()
        )


async def bundle_row(app: FastAPI, bundle_id: str) -> BundleRow:
    async with app.state.session_factory() as session:
        row: BundleRow | None = await session.get(BundleRow, uuid.UUID(bundle_id))
        assert row is not None
        return row
