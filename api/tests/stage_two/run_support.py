import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy import select, update

from tessa_api.db.models import (
    BrowserSessionRow,
    CoverageCellRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    StepRow,
)
from tessa_api.ids import new_id
from tessa_api.schemas.artifacts import StoredArtifact
from tessa_api.schemas.enums import (
    AdapterKind,
    ArtifactKind,
    BrowserSessionStatus,
    RunScenarioStatus,
    RunStatus,
    SkipReason,
)
from tessa_api.services.artifacts import LocalArtifactStore
from tessa_api.services.plans import expand_plan_cells
from tessa_api.services.smoke_generator import generate_smoke_scenarios
from tessa_api.services.storage import bundle_store_from_settings
from tests.stage_two.support import (
    CREATE_ISSUE,
    LIST_USERS,
    OPEN_ISSUES,
    SeededTarget,
    plan_body,
    post_run,
)

SHOT = b"\x89PNG\r\n\x1a\n" + b"s" * 300
RECORDING = b"webm" * 5000
TRACE = b"PK\x03\x04" + b"t" * 900


def verdict(status: str, reason_code: str | None = None) -> dict[str, Any]:
    return {
        "status": status,
        "tier": "code",
        "confidence": None,
        "reason_code": reason_code,
        "reason": None,
        "skip_reason": None,
    }


@dataclass
class FinishedRun:
    run_id: str
    plan_id: str
    run_scenarios: dict[str, uuid.UUID] = field(default_factory=dict)
    steps: dict[str, uuid.UUID] = field(default_factory=dict)
    artifacts: dict[str, uuid.UUID] = field(default_factory=dict)
    sessions: dict[str, uuid.UUID] = field(default_factory=dict)


async def start_run(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    seeded: SeededTarget,
    key: str = "run-key-support",
    **selection: Any,
) -> dict[str, Any]:
    selection.setdefault("feature_ids", [OPEN_ISSUES, CREATE_ISSUE, LIST_USERS])
    selection.setdefault("interface_mode", "both")
    body = {"plan": plan_body(seeded.target_id, saved=False, **selection)}
    response = await post_run(client, headers, body, key)
    assert response.status_code == 202, response.text
    handle: dict[str, Any] = response.json()
    return handle


async def scenario_for(
    app: FastAPI, plan_id: uuid.UUID, feature: str, role: str, interface: str
) -> tuple[uuid.UUID, str]:
    store = bundle_store_from_settings(app.state.settings)
    async with app.state.session_factory() as session:
        for cell_id in await expand_plan_cells(session, plan_id):
            cell = await session.get(CoverageCellRow, cell_id)
            assert cell is not None
            await generate_smoke_scenarios(session, store, cell_id)
        await session.commit()
        rows = (
            await session.scalars(select(ScenarioRow).where(ScenarioRow.feature_id == feature))
        ).all()
        found = next(
            row
            for row in rows
            if row.parsed["role"] == role and row.parsed["interface_id"] == interface
        )
        return found.id, found.yaml


async def build_finished_run(
    app: FastAPI,
    client: httpx.AsyncClient,
    headers: dict[str, str],
    seeded: SeededTarget,
) -> FinishedRun:
    handle = await start_run(client, headers, seeded)
    run_id = uuid.UUID(handle["run_id"])
    async with app.state.session_factory() as session:
        run = await session.get(RunRow, run_id)
        assert run is not None
        assert run.plan_id is not None
        plan_id = run.plan_id
    finished = FinishedRun(run_id=str(run_id), plan_id=str(plan_id))
    store = LocalArtifactStore(app.state.settings.data_dir)
    now = datetime.now(UTC)
    chat_id, _ = await scenario_for(app, plan_id, OPEN_ISSUES, "staff", "chat_sse")
    manager_id, _ = await scenario_for(app, plan_id, OPEN_ISSUES, "manager", "chat_sse")
    browser_id, _ = await scenario_for(app, plan_id, CREATE_ISSUE, "staff", "browser")
    users_id, _ = await scenario_for(app, plan_id, LIST_USERS, "admin", "admin_api")
    specs: list[
        tuple[
            str,
            uuid.UUID,
            str,
            str,
            RunScenarioStatus,
            dict[str, Any] | None,
            SkipReason | None,
            int,
        ]
    ] = [
        (
            "chat",
            chat_id,
            "staff",
            "chat_sse",
            RunScenarioStatus.finished,
            verdict("pass"),
            None,
            2,
        ),
        (
            "manager",
            manager_id,
            "manager",
            "chat_sse",
            RunScenarioStatus.finished,
            verdict("fail", "tier0_failed"),
            None,
            2,
        ),
        (
            "browser",
            browser_id,
            "staff",
            "browser",
            RunScenarioStatus.finished,
            verdict("flaky"),
            None,
            2,
        ),
        (
            "users",
            users_id,
            "admin",
            "admin_api",
            RunScenarioStatus.skipped,
            verdict("skipped"),
            SkipReason.env_missing,
            1,
        ),
    ]
    async with app.state.session_factory() as session:
        for index, (
            name,
            scenario_id,
            role,
            interface,
            status,
            outcome,
            reason,
            attempts,
        ) in enumerate(specs):
            scenario = await session.get(ScenarioRow, scenario_id)
            assert scenario is not None
            row = RunScenarioRow(
                id=new_id(),
                run_id=run_id,
                scenario_id=scenario_id,
                scenario_version=scenario.version,
                role=role,
                interface_id=interface,
                attempts_total=attempts,
                status=status,
                verdict=outcome,
                skip_reason=reason,
                attempts=[
                    {
                        "attempt": attempt,
                        "status": "finished",
                        "verdict": verdict("pass" if attempt == 0 else "fail"),
                    }
                    for attempt in range(attempts)
                    if status is RunScenarioStatus.finished
                ],
                started_at=now + timedelta(seconds=index),
                finished_at=now + timedelta(seconds=index, milliseconds=1500),
            )
            session.add(row)
            finished.run_scenarios[name] = row.id
        await session.commit()
    shot = await store.put(new_id(), SHOT, ArtifactKind.screenshot, "image/png")
    recording = await store.put(new_id(), RECORDING, ArtifactKind.recording, "video/webm")
    trace = await store.put(new_id(), TRACE, ArtifactKind.trace, "application/zip")
    finished.artifacts.update({"shot": shot.id, "recording": recording.id, "trace": trace.id})
    async with app.state.session_factory() as session:
        for attempt in (0, 1):
            for index, adapter in enumerate((AdapterKind.sse, AdapterKind.sse)):
                step = StepRow(
                    id=new_id(),
                    run_scenario_id=finished.run_scenarios["chat"],
                    run_id=run_id,
                    attempt=attempt,
                    index=index,
                    adapter=adapter,
                    label=f"ask {attempt}.{index}",
                    request={
                        "kind": "sse",
                        "method": "POST",
                        "url": "http://localhost:8080/api/chat/message",
                        "headers": {"Authorization": "Bearer ${ADMIN_TOKEN}"},
                        "query": None,
                        "body": {"message": "Which maintenance issues are still open?"},
                    },
                    response={
                        "kind": "sse",
                        "status": 200,
                        "events": [{"event": "token", "data": "Four", "at_ms": 12}],
                        "closed_by": "server",
                    },
                    response_truncated=False,
                    ask="Which maintenance issues are still open?",
                    answer="Four rooms have open maintenance issues.",
                    tools=[
                        {
                            "name": "query_issues",
                            "args": {"status": "open"},
                            "result_summary": "4 rows",
                        }
                    ],
                    cards=[{"kind": "summary", "count": 4}],
                    tier0={
                        "passed": attempt == 0,
                        "failures": []
                        if attempt == 0
                        else [
                            {
                                "check": "latency",
                                "message": "slow",
                                "expected": 1000,
                                "actual": 2500,
                            }
                        ],
                    },
                    latency_ms=120 + index,
                    cost_usd=0,
                    artifacts=[shot.model_dump(mode="json")] if index == 0 else [],
                    ok=True,
                    tier0_failure_count=0 if attempt == 0 else 1,
                    screenshot_count=1 if index == 0 else 0,
                    started_at=now,
                    finished_at=now + timedelta(milliseconds=120),
                )
                session.add(step)
                finished.steps[f"chat-{attempt}-{index}"] = step.id
        browser_step = StepRow(
            id=new_id(),
            run_scenario_id=finished.run_scenarios["browser"],
            run_id=run_id,
            attempt=0,
            index=0,
            adapter=AdapterKind.browser,
            label="goto /login",
            request={
                "kind": "browser",
                "action": "navigate",
                "target": None,
                "text": None,
                "url": "/login",
            },
            response={
                "kind": "browser",
                "url": "http://localhost:8080/login",
                "title": "Login",
                "text_excerpt": "Sign in",
                "console": [{"level": "error", "text": "boom"}],
                "dom_state": None,
            },
            tier0={"passed": True, "failures": []},
            latency_ms=300,
            artifacts=[shot.model_dump(mode="json")],
            ok=True,
            screenshot_count=1,
            started_at=now,
            finished_at=now + timedelta(milliseconds=300),
        )
        session.add(browser_step)
        finished.steps["browser-0-0"] = browser_step.id
        for name, session_status, recording_ref, trace_ref in (
            ("done", BrowserSessionStatus.ended, recording, trace),
            ("live", BrowserSessionStatus.active, None, None),
        ):
            browser_session = BrowserSessionRow(
                id=new_id(),
                run_id=run_id,
                run_scenario_id=finished.run_scenarios["browser"],
                attempt=0 if name == "done" else 1,
                status=session_status,
                viewport={"width": 1280, "height": 720},
                last_url="http://localhost:8080/" if name == "done" else None,
                recording=recording_ref.model_dump(mode="json")
                if isinstance(recording_ref, StoredArtifact)
                else None,
                trace=trace_ref.model_dump(mode="json")
                if isinstance(trace_ref, StoredArtifact)
                else None,
                started_at=now,
                ended_at=now + timedelta(seconds=5) if name == "done" else None,
            )
            session.add(browser_session)
            finished.sessions[name] = browser_session.id
        await session.execute(
            update(RunRow)
            .where(RunRow.id == run_id)
            .values(
                status=RunStatus.completed,
                started_at=now,
                finished_at=now + timedelta(seconds=90),
                spent_usd=0,
                counters={
                    "scenarios_total": 4,
                    "scenarios_done": 4,
                    "pass": 1,
                    "fail": 1,
                    "flaky": 1,
                    "uncertain": 0,
                    "skipped": 1,
                    "steps_recorded": 5,
                },
            )
        )
        await session.commit()
    return finished
