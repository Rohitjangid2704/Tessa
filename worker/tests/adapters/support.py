import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import FastAPI

from tessa_api.auth.jwt import encode_api_token
from tessa_api.auth.users import create_user
from tessa_api.db.models import BundleRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.bundle_references import SKIP_REFERENCE_CHECKS
from tessa_api.schemas.enums import EnvVarKind, UserRole
from tessa_api.services.environment import infer_kind
from tessa_api.services.vault import Vault, vault_from_settings
from tessa_api.settings import Settings
from tessa_worker.adapters.auth import (
    EnvironmentValue,
    ResolvedEnvironment,
    load_environment,
)
from tessa_worker.adapters.context import AdapterContext, AdapterLimits, build_adapter_context
from tests.fake_target.bundle import build_bundle_zip
from tests.fake_target.dataset import (
    ADMIN_TOKEN,
    MANAGER_TOKEN,
    STAFF_EMAIL,
    STAFF_PASSWORD,
)
from tests.fake_target.server import RunningTarget

STEP_TIMEOUT_SECONDS = 10.0
MAX_PAYLOAD_BYTES = 262144
ZIP_TYPE = "application/zip"


@dataclass
class RegisteredTarget:
    user_id: uuid.UUID
    target_id: uuid.UUID
    bundle_id: uuid.UUID
    headers: dict[str, str]
    manifest: BundleManifest
    environment: ResolvedEnvironment
    session_factory: SessionFactory
    vault: Vault
    running: RunningTarget

    def context(
        self,
        role: str,
        interface_id: str,
        max_payload_bytes: int = MAX_PAYLOAD_BYTES,
        step_timeout_seconds: float = STEP_TIMEOUT_SECONDS,
    ) -> AdapterContext:
        return build_adapter_context(
            self.manifest,
            self.environment,
            role,
            interface_id,
            AdapterLimits(max_payload_bytes, step_timeout_seconds),
        )

    async def reload_environment(self) -> ResolvedEnvironment:
        async with self.session_factory() as session:
            self.environment = await load_environment(session, self.vault, self.target_id)
        return self.environment


def fake_target_values(base_url: str) -> dict[str, str]:
    return {
        "FAKE_TARGET_URL": base_url,
        "STAFF_EMAIL": STAFF_EMAIL,
        "STAFF_PASSWORD": STAFF_PASSWORD,
        "MANAGER_TOKEN": MANAGER_TOKEN,
        "ADMIN_TOKEN": ADMIN_TOKEN,
    }


async def register_fake_target(
    app: FastAPI,
    client: httpx.AsyncClient,
    settings: Settings,
    running: RunningTarget,
    values: dict[str, str] | None = None,
) -> RegisteredTarget:
    session_factory: SessionFactory = app.state.session_factory
    async with session_factory() as session:
        user = await create_user(
            session,
            email=f"adapters-{uuid.uuid4().hex[:8]}@tessa.test",
            name="Adapters",
            password="x" * 20,
            role=UserRole.member,
        )
    token = encode_api_token(settings, user.id, user.email, user.role)
    headers = {"Authorization": f"Bearer {token}"}
    created = await client.post(
        "/api/v1/targets",
        json={"name": "Fake Target", "app_kind": "llm_assistant"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    target: dict[str, Any] = created.json()
    uploaded = await client.post(
        "/api/v1/bundles",
        files={"file": ("tessa.zip", build_bundle_zip(target["target_token"]), ZIP_TYPE)},
        headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert uploaded.status_code == 201, uploaded.text
    environment_values = values if values is not None else fake_target_values(running.base_url)
    patched = await client.patch(
        f"/api/v1/targets/{target['id']}/environment",
        json={"set": environment_values},
        headers=headers,
    )
    assert patched.status_code == 200, patched.text
    vault = vault_from_settings(settings)
    bundle_id = uuid.UUID(uploaded.json()["bundle"]["id"])
    async with session_factory() as session:
        row = await session.get(BundleRow, bundle_id)
        assert row is not None
        assert row.manifest is not None
        manifest = BundleManifest.model_validate(row.manifest)
        environment = await load_environment(session, vault, uuid.UUID(target["id"]))
    return RegisteredTarget(
        user_id=user.id,
        target_id=uuid.UUID(target["id"]),
        bundle_id=bundle_id,
        headers=headers,
        manifest=manifest,
        environment=environment,
        session_factory=session_factory,
        vault=vault,
        running=running,
    )


def minimal_manifest(
    interfaces: list[dict[str, Any]] | None = None,
    roles: list[dict[str, Any]] | None = None,
) -> BundleManifest:
    declared_interfaces = interfaces or [{"id": "api", "kind": "http", "base_path": "/api"}]
    declared_roles = roles or [{"id": "staff", "level": 1, "description": "Staff"}]
    return BundleManifest.model_validate(
        {
            "schema": "http://localhost:8000/schemas/bundle.v1.json",
            "target_token": "tgt_" + "a" * 22,
            "app": {"name": "Unit", "summary": "Unit", "kind": "api", "how_to_run": "none"},
            "interfaces": declared_interfaces,
            "roles": declared_roles,
            "features": [
                {
                    "id": "unit.feature",
                    "area": "Unit",
                    "kind": "read",
                    "description": "Unit feature",
                    "interfaces": [item["id"] for item in declared_interfaces],
                    "roles": ["all"],
                }
            ],
            "environment": [{"name": "UNIT_URL", "kind": "url", "secret": False}],
        },
        context={SKIP_REFERENCE_CHECKS: True},
    )


def environment_of(**values: str) -> ResolvedEnvironment:
    return ResolvedEnvironment(
        EnvironmentValue(
            name=name,
            kind=infer_kind(name),
            secret=infer_kind(name) is not EnvVarKind.url and name != "STAFF_EMAIL",
            interface_ids=("api", "chat_sse", "browser", "qa"),
            value=value,
        )
        for name, value in values.items()
    )


def local_context(
    base_url: str,
    kind: str = "http",
    base_path: str = "/qa",
    auth: dict[str, Any] | None = None,
    values: dict[str, str] | None = None,
    role: str = "staff",
    max_payload_bytes: int = MAX_PAYLOAD_BYTES,
    step_timeout_seconds: float = STEP_TIMEOUT_SECONDS,
) -> AdapterContext:
    interface: dict[str, Any] = {
        "id": "qa",
        "kind": kind,
        "base_path": base_path,
        "health_endpoint": "/health",
    }
    if auth is not None:
        interface["auth"] = auth
    roles = [
        {"id": name, "level": level, "description": name}
        for level, name in enumerate(("staff", "manager", "admin"), start=1)
    ]
    return build_adapter_context(
        minimal_manifest([interface], roles),
        environment_of(UNIT_URL=base_url, **(values or {})),
        role,
        "qa",
        AdapterLimits(max_payload_bytes, step_timeout_seconds),
    )
