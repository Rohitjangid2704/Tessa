import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx
import yaml
from fastapi import FastAPI
from sqlalchemy import func, select

from tessa_api.db.models import AuditEventRow, RunRow
from tessa_api.schemas.enums import AuditAction
from tests.stage_two.run_support import scenario_for, start_run
from tests.stage_two.support import CREATE_ISSUE, LIST_USERS, OPEN_ISSUES, SeededTarget

MY_TOKENS_PATH = "/api/v1/users/me/tokens"
PROPOSAL_SCHEMA_URL = "http://localhost:8000/schemas/proposal.v1.json"
OPEN_ISSUES_ITEM: dict[str, Any] = {
    "key": "open-issues-count",
    "title": "Open issue counts match the database",
    "area": "Smart Log",
    "feature_ids": [OPEN_ISSUES],
    "interface_id": "chat_sse",
    "kind": "stream",
    "risk": "high",
    "reasons": [{"code": "money_path", "note": "the count drives billing"}],
    "depth": "smoke",
    "confidence": "high",
}
CREATE_ISSUE_ITEM: dict[str, Any] = {
    "key": "create-issue-browser",
    "title": "Staff create an issue in the browser",
    "area": "Smart Log",
    "feature_ids": [CREATE_ISSUE],
    "interface_id": "browser",
    "kind": "browser",
    "risk": "medium",
    "reasons": [{"code": "recent_change"}],
    "depth": "standard",
    "confidence": "medium",
}
USERS_ITEM: dict[str, Any] = {
    "key": "admin-users-list",
    "title": "Only admins list users",
    "area": "Admin",
    "feature_ids": [LIST_USERS],
    "interface_id": "admin_api",
    "kind": "api",
    "risk": "low",
    "reasons": [{"code": "auth_path"}],
    "depth": "smoke",
    "confidence": "medium",
}


@dataclass(frozen=True)
class AcceptedScenarios:
    plan_id: uuid.UUID
    chat: uuid.UUID
    browser: uuid.UUID
    admin_api: uuid.UUID


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class PlainDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def proposal_yaml(token: str, *items: dict[str, Any]) -> str:
    document = {
        "schema": PROPOSAL_SCHEMA_URL,
        "target_token": token,
        "items": list(items) or [OPEN_ISSUES_ITEM, CREATE_ISSUE_ITEM, USERS_ITEM],
    }
    dumped: str = yaml.dump(document, Dumper=PlainDumper, sort_keys=False)
    return dumped


async def create_personal_token(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    name: str = "laptop",
    **fields: Any,
) -> dict[str, Any]:
    response = await client.post(MY_TOKENS_PATH, json={"name": name, **fields}, headers=headers)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


async def run_row(app: FastAPI, run_id: str | uuid.UUID) -> RunRow:
    async with app.state.session_factory() as session:
        row: RunRow | None = await session.get(RunRow, uuid.UUID(str(run_id)))
        assert row is not None
        return row


async def count_runs(app: FastAPI) -> int:
    async with app.state.session_factory() as session:
        return int(await session.scalar(select(func.count()).select_from(RunRow)) or 0)


async def audit_rows(
    app: FastAPI, actions: Sequence[AuditAction] | None = None
) -> list[AuditEventRow]:
    statement = select(AuditEventRow).order_by(AuditEventRow.created_at, AuditEventRow.id)
    if actions is not None:
        statement = statement.where(AuditEventRow.action.in_(list(actions)))
    async with app.state.session_factory() as session:
        return list((await session.scalars(statement)).all())


async def accepted_scenarios(
    app: FastAPI, client: httpx.AsyncClient, headers: dict[str, str], seeded: SeededTarget
) -> AcceptedScenarios:
    handle = await start_run(client, headers, seeded, key=f"baseline-{uuid.uuid4()}")
    run = await run_row(app, handle["run_id"])
    assert run.plan_id is not None
    chat, _ = await scenario_for(app, run.plan_id, OPEN_ISSUES, "staff", "chat_sse")
    browser, _ = await scenario_for(app, run.plan_id, CREATE_ISSUE, "staff", "browser")
    admin_api, _ = await scenario_for(app, run.plan_id, LIST_USERS, "admin", "admin_api")
    return AcceptedScenarios(run.plan_id, chat, browser, admin_api)
