import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import FastAPI

from tessa_api.db.models import BrowserSessionRow, RunRow, RunScenarioRow, ScenarioRow, User
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    BrowserSessionStatus,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    RunTrigger,
    ScenarioOrigin,
    ScenarioStatus,
)
from tests.stage_one import create_target, insert_bundle, sample_manifest


@dataclass(frozen=True)
class World:
    app: FastAPI
    user_id: uuid.UUID
    target_id: uuid.UUID
    bundle_id: uuid.UUID
    scenario_id: uuid.UUID


@dataclass(frozen=True)
class RunRows:
    run_id: uuid.UUID
    target_id: uuid.UUID
    run_scenario_id: uuid.UUID
    session_ids: list[uuid.UUID]


async def create_world(
    app: FastAPI, client: httpx.AsyncClient, user: User, headers: dict[str, str]
) -> World:
    target = await create_target(client, headers, name=f"Target {new_id()}")
    target_id = uuid.UUID(target["id"])
    bundle = await insert_bundle(app, target_id, user.id, sample_manifest())
    scenario = ScenarioRow(
        id=new_id(),
        target_id=target_id,
        bundle_id=bundle.id,
        feature_id="a.b",
        title="Ask",
        family="area",
        origin=ScenarioOrigin.bundle_example,
        status=ScenarioStatus.accepted,
        yaml="schema_version: 1\n",
        parsed={"schema_version": 1},
        validation={"valid": True, "errors": [], "warnings": []},
    )
    async with app.state.session_factory() as session:
        session.add(scenario)
        await session.commit()
    return World(app, user.id, target_id, bundle.id, scenario.id)


async def add_run(
    world: World,
    kind: RunKind = RunKind.suite,
    sessions: int = 0,
    session_status: BrowserSessionStatus = BrowserSessionStatus.active,
    target_id: uuid.UUID | None = None,
) -> RunRows:
    run = RunRow(
        id=new_id(),
        kind=kind,
        target_id=target_id or world.target_id,
        bundle_id=world.bundle_id,
        status=RunStatus.queued,
        trigger=RunTrigger.manual,
        config_snapshot={},
        budget={"max_usd": 5.0, "max_minutes": 30},
        counters={},
        workflow_id=f"execute-run-{new_id()}",
        created_by=world.user_id,
    )
    run_scenario = RunScenarioRow(
        id=new_id(),
        run_id=run.id,
        scenario_id=world.scenario_id,
        scenario_version=1,
        role="staff",
        interface_id="browser",
        attempts_total=1,
        status=RunScenarioStatus.queued,
    )
    browser_sessions = [
        BrowserSessionRow(
            id=new_id(),
            run_id=run.id,
            run_scenario_id=run_scenario.id,
            attempt=0,
            status=session_status,
            viewport={"width": 1280, "height": 720},
        )
        for _ in range(sessions)
    ]
    async with world.app.state.session_factory() as session:
        session.add(run)
        await session.flush()
        session.add(run_scenario)
        await session.flush()
        session.add_all(browser_sessions)
        await session.commit()
    return RunRows(
        run.id,
        run.target_id or world.target_id,
        run_scenario.id,
        [row.id for row in browser_sessions],
    )


def started_payload(session_id: uuid.UUID, run_scenario_id: uuid.UUID) -> dict[str, Any]:
    return {
        "browser_session_id": str(session_id),
        "run_scenario_id": str(run_scenario_id),
        "attempt": 0,
        "viewport": {"width": 1280, "height": 720},
        "scenario_title": "Ask",
        "started_at": "2026-09-30T14:03:22.123Z",
    }
