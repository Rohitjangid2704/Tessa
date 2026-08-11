import secrets
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from tessa_api.db.models import BundleRow, Target
from tessa_api.main import create_app
from tessa_api.settings import Settings
from tests.bundle_fixtures import build_fixture
from tests.bundles.support import (
    BUNDLES_PATH,
    PASTE_PATH,
    new_key,
    upload_paste,
    upload_zip,
)
from tests.stage_one import TARGETS_PATH
from tests.support import settings_with
from tests.zip_builder import build_zip

pytestmark = pytest.mark.integration


async def bundle_count(app: FastAPI) -> int:
    async with app.state.session_factory() as session:
        return int(await session.scalar(select(func.count()).select_from(BundleRow)) or 0)


@pytest.fixture
def small_settings(tmp_path: Path) -> Settings:
    return settings_with(
        data_dir=tmp_path / "data", bundle_max_zip_bytes=2000, bundle_max_manifest_bytes=500
    )


@pytest.fixture
async def small_client(
    small_settings: Settings, db_app: FastAPI
) -> AsyncIterator[httpx.AsyncClient]:
    application = create_app(small_settings)
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            yield http


async def test_declared_content_length_over_the_limit_is_413_before_parsing(
    small_client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    body = b"x" * (2000 + 70_000)
    response = await small_client.post(
        BUNDLES_PATH,
        content=body,
        headers={
            **member_headers,
            "Idempotency-Key": new_key(),
            "Content-Type": "multipart/form-data; boundary=xyz",
        },
    )
    assert response.status_code == 413
    error = response.json()["error"]
    assert error["code"] == "payload_too_large"
    assert error["details"][0]["code"] == "body_too_large"


async def test_streamed_body_without_a_length_is_cut_off_mid_stream(
    small_client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    opening = (
        b"--xyz\r\n"
        b'Content-Disposition: form-data; name="file"; filename="a.zip"\r\n'
        b"Content-Type: application/zip\r\n\r\n"
    )

    async def chunks() -> AsyncIterator[bytes]:
        yield opening
        for _ in range(100):
            yield b"y" * 1024

    request = small_client.build_request(
        "POST",
        BUNDLES_PATH,
        content=chunks(),
        headers={
            **member_headers,
            "Idempotency-Key": new_key(),
            "Content-Type": "multipart/form-data; boundary=xyz",
        },
    )
    assert "content-length" not in request.headers
    response = await small_client.send(request)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


async def test_zip_over_the_configured_size_is_413(
    small_client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    data = build_zip({"manifest.yaml": secrets.token_hex(2500), "pad.txt": secrets.token_hex(2500)})
    assert 2000 < len(data) < 60_000
    response = await upload_zip(small_client, member_headers, data)
    assert response.status_code == 413
    assert response.json()["error"]["details"][0]["code"] == "archive_too_large"


async def test_paste_body_over_the_manifest_limit_is_413(
    small_client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await upload_paste(small_client, member_headers, "a: " + "z" * 600)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
    assert response.json()["error"]["details"][0]["code"] == "manifest_too_large"


async def test_the_guard_does_not_touch_other_routes(
    small_client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await small_client.post(
        TARGETS_PATH,
        json={"name": "A" * 5000, "app_kind": "api"},
        headers=member_headers,
    )
    assert response.status_code != 413


async def test_non_zip_content_type_is_415(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str, db_app: FastAPI
) -> None:
    response = await upload_zip(
        client,
        member_headers,
        build_fixture("minimal_valid", token),
        content_type="application/octet-stream",
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"
    assert await bundle_count(db_app) == 0


@pytest.mark.parametrize("content_type", ["application/zip", "application/x-zip-compressed"])
async def test_both_zip_content_types_are_accepted(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str, content_type: str
) -> None:
    response = await upload_zip(
        client, member_headers, build_fixture("minimal_valid", token), content_type=content_type
    )
    assert response.status_code == 201


async def test_a_file_that_is_not_a_zip_is_422(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await upload_zip(client, member_headers, b"not a zip")
    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["code"] == "invalid_archive"


async def test_note_over_500_characters_is_422(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    response = await upload_zip(
        client, member_headers, build_fixture("minimal_valid", token), note="n" * 501
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"
    accepted = await upload_zip(
        client, member_headers, build_fixture("minimal_valid", token), note="n" * 500
    )
    assert accepted.status_code == 201


async def test_missing_file_field_is_422(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await client.post(
        BUNDLES_PATH,
        data={"note": "no file"},
        headers={**member_headers, "Idempotency-Key": new_key()},
    )
    assert response.status_code == 422


async def test_idempotency_key_is_required_on_both_posts(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str
) -> None:
    upload = await client.post(
        BUNDLES_PATH,
        files={"file": ("a.zip", build_fixture("minimal_valid", token), "application/zip")},
        headers=member_headers,
    )
    paste = await client.post(PASTE_PATH, json={"manifest_yaml": "a: 1"}, headers=member_headers)
    assert upload.status_code == 400
    assert upload.json()["error"]["code"] == "idempotency_key_required"
    assert paste.status_code == 400
    assert paste.json()["error"]["code"] == "idempotency_key_required"


async def test_viewers_cannot_upload_and_anonymous_is_unauthenticated(
    client: httpx.AsyncClient, viewer_headers: dict[str, str], token: str
) -> None:
    data = build_fixture("minimal_valid", token)
    viewer = await upload_zip(client, viewer_headers, data)
    anonymous = await upload_zip(client, {}, data)
    assert viewer.status_code == 403
    assert viewer.json()["error"]["code"] == "role_required"
    assert anonymous.status_code == 401


async def test_unknown_target_token_is_422(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    response = await upload_zip(
        client, member_headers, build_fixture("minimal_valid", "tgt_" + "z" * 22)
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "target_token_unknown"
    assert error["details"][0]["loc"] == ["manifest", "target_token"]
    assert await bundle_count(db_app) == 0


async def test_manifest_without_a_token_and_no_target_id_is_422(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await upload_paste(client, member_headers, "app:\n  name: x\n")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "target_token_unknown"


async def test_target_id_must_match_the_manifest_token(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    db_app: FastAPI,
) -> None:
    other = await client.post(
        TARGETS_PATH, json={"name": "Other", "app_kind": "api"}, headers=member_headers
    )
    other_id = other.json()["id"]
    data = build_fixture("minimal_valid", target["target_token"])
    mismatch = await upload_zip(client, member_headers, data, target_id=other_id)
    assert mismatch.status_code == 409
    assert mismatch.json()["error"]["code"] == "target_token_mismatch"
    assert await bundle_count(db_app) == 0
    match = await upload_zip(client, member_headers, data, target_id=target["id"])
    assert match.status_code == 201


async def test_unknown_target_id_without_a_token_is_404(
    client: httpx.AsyncClient, member_headers: dict[str, str]
) -> None:
    response = await upload_paste(
        client,
        member_headers,
        "app:\n  name: x\n",
        target_id="01a0f70a-8f7f-79e1-8f37-7dc48c8f6ad6",
    )
    assert response.status_code == 404


async def test_previous_token_still_matches_with_a_warning(
    client: httpx.AsyncClient, member_headers: dict[str, str], target: dict[str, Any]
) -> None:
    old_token = target["target_token"]
    rotated = await client.post(
        f"{TARGETS_PATH}/{target['id']}/token/rotate", headers=member_headers
    )
    assert rotated.json()["target_token"] != old_token
    response = await upload_zip(client, member_headers, build_fixture("minimal_valid", old_token))
    assert response.status_code == 201
    warnings = response.json()["bundle"]["warnings"]
    assert [warning["code"] for warning in warnings] == ["target_token_rotated"]
    current = await upload_zip(
        client,
        member_headers,
        build_fixture("gracie_like", rotated.json()["target_token"]),
    )
    assert current.json()["bundle"]["warnings"] == []


async def test_archived_target_does_not_accept_bundles(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    target: dict[str, Any],
    admin_headers: dict[str, str],
) -> None:
    archived = await client.delete(f"{TARGETS_PATH}/{target['id']}", headers=admin_headers)
    assert archived.status_code == 204
    response = await upload_zip(
        client, member_headers, build_fixture("minimal_valid", target["target_token"])
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"


async def test_target_rows_are_untouched_by_a_refused_upload(
    client: httpx.AsyncClient, member_headers: dict[str, str], token: str, db_app: FastAPI
) -> None:
    await upload_zip(client, member_headers, build_fixture("secret_bearing", token))
    async with db_app.state.session_factory() as session:
        target = await session.scalar(select(Target).where(Target.target_token == token))
    assert target is not None
    assert target.previous_target_token is None
