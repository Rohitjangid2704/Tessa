import uuid
from collections.abc import Sequence
from typing import Any

import httpx
from fastapi import FastAPI

from tessa_api.db.models import BundleRow
from tessa_api.schemas.enums import BundleSourceKind, BundleValidationStatus

TARGETS_PATH = "/api/v1/targets"


def environment_path(target_id: str) -> str:
    return f"{TARGETS_PATH}/{target_id}/environment"


def sample_manifest(
    interfaces: Sequence[dict[str, Any]] = (),
    truth_sources: Sequence[dict[str, Any]] = (),
) -> dict[str, Any]:
    return {
        "app": {"name": "Sample", "kind": "api"},
        "interfaces": list(interfaces),
        "truth_sources": list(truth_sources),
        "environment": [],
    }


def completeness(score: int) -> dict[str, Any]:
    return {
        "score": score,
        "bar": 80,
        "status": "meets_bar" if score >= 80 else "below_bar",
        "checks": [],
    }


async def insert_bundle(
    app: FastAPI,
    target_id: uuid.UUID | str,
    uploaded_by: uuid.UUID,
    manifest: dict[str, Any] | None,
    version: int = 1,
    valid: bool = True,
    score: int = 100,
) -> BundleRow:
    row = BundleRow(
        target_id=uuid.UUID(str(target_id)),
        version=version,
        hash=f"hash-{target_id}-{version}",
        source=BundleSourceKind.zip,
        schema_version=1,
        validation_status=BundleValidationStatus.valid if valid else BundleValidationStatus.invalid,
        completeness=completeness(score),
        manifest=manifest,
        uploaded_by=uploaded_by,
    )
    async with app.state.session_factory() as session:
        session.add(row)
        await session.commit()
    return row


async def create_target(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    name: str = "Gracie",
    app_kind: str = "llm_assistant",
    **fields: Any,
) -> dict[str, Any]:
    response = await client.post(
        TARGETS_PATH, json={"name": name, "app_kind": app_kind, **fields}, headers=headers
    )
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created
