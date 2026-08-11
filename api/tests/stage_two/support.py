from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel

from tessa_api.temporal_client import WorkflowNotRunningError, temporal_unavailable
from tests.bundle_fixtures import gracie_like_zip
from tests.bundles.support import upload_zip
from tests.stage_one import create_target, environment_path

PLANS_PATH = "/api/v1/plans"
RUNS_PATH = "/api/v1/runs"
SCENARIOS_PATH = "/api/v1/scenarios"

GRACIE_VALUES = {
    "GRACIE_BASE_URL": "http://localhost:8080",
    "STAFF_EMAIL": "staff@example.test",
    "STAFF_PASSWORD": "staff-password-value-1",
    "MANAGER_TOKEN": "manager-token-value-1",
    "ADMIN_TOKEN": "admin-token-value-1",
    "SMART_LOG_TENANT_ID": "tenant-1",
    "TRUTH_DB_DSN": "postgresql://reader:reader-secret@db.internal:5432/gracie",
}

OPEN_ISSUES = "smart_log.read.open_maintenance"
CREATE_ISSUE = "smart_log.write.create_issue"
LOGIN_STAFF = "auth.login.staff"
LIST_USERS = "admin.users.list"


@dataclass
class StartedWorkflow:
    name: str
    argument: dict[str, Any]
    workflow_id: str


class FakeTemporal:
    def __init__(self) -> None:
        self.started: list[StartedWorkflow] = []
        self.signals: list[tuple[str, str]] = []
        self.unavailable = False
        self.start_failure: Exception | None = None
        self.signal_failure: Exception | None = None
        self.not_running = False

    async def ensure_available(self) -> None:
        if self.unavailable:
            raise temporal_unavailable("test double is down")

    async def start_workflow(self, name: str, argument: BaseModel, workflow_id: str) -> None:
        if self.unavailable:
            raise temporal_unavailable("test double is down")
        if self.start_failure is not None:
            raise self.start_failure
        self.started.append(StartedWorkflow(name, argument.model_dump(mode="json"), workflow_id))

    async def signal_workflow(self, workflow_id: str, signal: str) -> None:
        if self.unavailable:
            raise temporal_unavailable("test double is down")
        if self.not_running:
            raise WorkflowNotRunningError(workflow_id)
        if self.signal_failure is not None:
            raise self.signal_failure
        self.signals.append((workflow_id, signal))


@dataclass(frozen=True)
class SeededTarget:
    target_id: str
    token: str
    bundle_id: str


def selection(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "feature_ids": [OPEN_ISSUES],
        "area_ids": [],
        "roles": ["all"],
        "interface_mode": "api_only",
        "depth": "smoke",
        "k": 1,
    }
    return {**base, **overrides}


def plan_body(
    target_id: str, saved: bool = True, name: str | None = None, **selection_overrides: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "target_id": target_id,
        "saved": saved,
        "selection": selection(**selection_overrides),
    }
    if name is not None:
        body["name"] = name
    return body


async def set_environment(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    target_id: str,
    values: dict[str, str],
) -> None:
    response = await client.patch(
        environment_path(target_id), json={"set": values}, headers=headers
    )
    assert response.status_code == 200, response.text


async def clear_environment(
    client: httpx.AsyncClient, headers: dict[str, str], target_id: str, names: list[str]
) -> None:
    response = await client.patch(
        environment_path(target_id), json={"clear": names}, headers=headers
    )
    assert response.status_code == 200, response.text


async def seed_gracie(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    values: dict[str, str] | None = None,
    name: str = "Gracie",
) -> SeededTarget:
    target = await create_target(client, headers, name=name)
    token = str(target["target_token"])
    uploaded = await upload_zip(client, headers, gracie_like_zip(token))
    assert uploaded.status_code == 201, uploaded.text
    bundle_id = str(uploaded.json()["bundle"]["id"])
    chosen = GRACIE_VALUES if values is None else values
    if chosen:
        await set_environment(client, headers, str(target["id"]), chosen)
    return SeededTarget(target_id=str(target["id"]), token=token, bundle_id=bundle_id)


async def post_run(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    body: dict[str, Any],
    key: str = "run-key-0001",
) -> httpx.Response:
    return await client.post(RUNS_PATH, json=body, headers={**headers, "Idempotency-Key": key})
