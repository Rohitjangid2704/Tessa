import uuid
from pathlib import Path
from typing import Any

import httpx

from tessa_api.settings import Settings

BUNDLES_PATH = "/api/v1/bundles"
PASTE_PATH = "/api/v1/bundles/paste"
CATALOG_PATH = "/api/v1/catalog"
ZIP_TYPE = "application/zip"


def new_key() -> str:
    return str(uuid.uuid4())


def target_bundles_path(target_id: str) -> str:
    return f"/api/v1/targets/{target_id}/bundles"


def bundle_path(bundle_id: str, *parts: str) -> str:
    return "/".join([f"{BUNDLES_PATH}/{bundle_id}", *parts]).rstrip("/")


async def upload_zip(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    data: bytes,
    *,
    key: str | None = None,
    target_id: str | None = None,
    note: str | None = None,
    content_type: str = ZIP_TYPE,
    file_name: str = "tessa.zip",
) -> httpx.Response:
    form: dict[str, str] = {}
    if target_id is not None:
        form["target_id"] = target_id
    if note is not None:
        form["note"] = note
    return await client.post(
        BUNDLES_PATH,
        files={"file": (file_name, data, content_type)},
        data=form,
        headers={**headers, "Idempotency-Key": key or new_key()},
    )


async def upload_paste(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    manifest_yaml: str,
    *,
    key: str | None = None,
    target_id: str | None = None,
    note: str | None = None,
) -> httpx.Response:
    body: dict[str, Any] = {"manifest_yaml": manifest_yaml}
    if target_id is not None:
        body["target_id"] = target_id
    if note is not None:
        body["note"] = note
    return await client.post(
        PASTE_PATH, json=body, headers={**headers, "Idempotency-Key": key or new_key()}
    )


def stored_files(settings: Settings) -> list[Path]:
    root = settings.data_dir / "bundles"
    if not root.exists():
        return []
    return sorted(path for path in root.rglob("*") if path.is_file())


def staging_directories(settings: Settings) -> list[Path]:
    root = settings.data_dir / "bundles"
    if not root.exists():
        return []
    return sorted(path for path in root.rglob(".staging-*") if path.is_dir())
