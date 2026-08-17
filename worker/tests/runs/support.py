import json
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import select

from tessa_api.db.models import (
    BundleRow,
    PlanRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    StepRow,
    Target,
    User,
)
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.common import Budget
from tessa_api.schemas.enums import (
    AppKind,
    BundleSourceKind,
    BundleValidationStatus,
    Depth,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    RunTrigger,
    ScenarioOrigin,
    ScenarioStatus,
    UserRole,
)
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.schemas.streams import IngestEvent, IngestEventBatch, IngestEventResult
from tessa_worker.event_client import DeliveryPolicy

DEFAULT_BUDGET = Budget(max_usd=5.0, max_minutes=30)
FAST_DELIVERY = DeliveryPolicy(attempts=3, initial_delay_seconds=0.01, max_delay_seconds=0.02)


def scenario_steps(adapter: str, count: int) -> list[dict[str, Any]]:
    if adapter == "browser":
        return [
            {
                "adapter": "browser",
                "label": f"step {number}",
                "action": "goto",
                "url": f"/page/{number}",
                "expect": {"dom_state": {"url": f"/page/{number}"}},
            }
            for number in range(1, count + 1)
        ]
    return [
        {
            "adapter": "http",
            "label": f"step {number}",
            "request": {"method": "GET", "path": f"/items/{number}"},
            "expect": {"status": 200},
        }
        for number in range(1, count + 1)
    ]


def scenario_document(
    title: str = "List open issues",
    role: str = "staff",
    interface_id: str = "chat",
    timeout_seconds: int | None = None,
    steps: int = 1,
    adapter: str = "http",
) -> dict[str, Any]:
    document = ScenarioDoc.model_validate(
        {
            "schema_version": 1,
            "title": title,
            "feature_id": "smart_log.read.open_issues",
            "family": "smart-log",
            "role": role,
            "interface_id": interface_id,
            "timeout_seconds": timeout_seconds,
            "steps": scenario_steps(adapter, steps),
        }
    )
    return document.model_dump(mode="json", by_alias=True)


def new_run_row(
    target_id: uuid.UUID,
    plan_id: uuid.UUID,
    bundle_id: uuid.UUID,
    bundle_hash: str,
    user_id: uuid.UUID,
    status: RunStatus = RunStatus.queued,
    read_only: bool = False,
    budget: Budget = DEFAULT_BUDGET,
) -> RunRow:
    return RunRow(
        kind=RunKind.suite,
        target_id=target_id,
        plan_id=plan_id,
        bundle_id=bundle_id,
        status=status,
        trigger=RunTrigger.manual,
        read_only=read_only,
        config_snapshot={
            "bundle_id": str(bundle_id),
            "bundle_version": 1,
            "bundle_hash": bundle_hash,
            "seed_hash": None,
            "clock": None,
            "models": None,
            "probe_bank_version": None,
            "prompt_template_versions": {},
            "scenario_versions": {},
        },
        budget=budget.model_dump(mode="json"),
        counters={
            "scenarios_total": 0,
            "scenarios_done": 0,
            "pass": 0,
            "fail": 0,
            "flaky": 0,
            "uncertain": 0,
            "skipped": 0,
            "steps_recorded": 0,
        },
        workflow_id=f"execute-run-{new_id()}",
        created_by=user_id,
    )


@dataclass
class SeededRun:
    run_id: uuid.UUID
    plan_id: uuid.UUID
    target_id: uuid.UUID
    bundle_id: uuid.UUID
    user_id: uuid.UUID
    scenario_ids: list[uuid.UUID] = field(default_factory=list)
    run_scenario_ids: list[uuid.UUID] = field(default_factory=list)


async def seed_run(
    session_factory: SessionFactory,
    scenario_count: int = 3,
    attempts: int = 1,
    budget: Budget = DEFAULT_BUDGET,
    read_only: bool = False,
    status: RunStatus = RunStatus.queued,
    create_run_scenarios: bool = True,
    scenario_timeout_seconds: int | None = None,
    steps_per_scenario: int = 1,
    adapter: str = "http",
) -> SeededRun:
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        user = User(
            email=f"worker-{suffix}@example.test",
            name="Worker test",
            password_hash="not-a-real-hash",
            role=UserRole.admin,
        )
        session.add(user)
        await session.flush()
        target = Target(
            name=f"Target {suffix}",
            slug=f"target-{suffix}",
            app_kind=AppKind.llm_assistant,
            created_by=user.id,
        )
        session.add(target)
        await session.flush()
        bundle = BundleRow(
            target_id=target.id,
            version=1,
            hash=f"hash-{suffix}",
            source=BundleSourceKind.zip,
            schema_version=1,
            validation_status=BundleValidationStatus.valid,
            completeness={"score": 100, "bar": 80, "status": "meets_bar", "checks": []},
            manifest={"app": {"name": "Sample", "kind": "api"}, "interfaces": []},
            uploaded_by=user.id,
        )
        session.add(bundle)
        await session.flush()
        selection = {
            "feature_ids": [],
            "area_ids": [],
            "roles": [],
            "interface_mode": "api_only",
            "depth": "smoke",
            "k": attempts,
        }
        plan = PlanRow(
            target_id=target.id,
            bundle_id=bundle.id,
            name="Plan",
            saved=False,
            selection=selection,
            depth=Depth.smoke,
            k=attempts,
            budget=budget.model_dump(mode="json"),
            created_by=user.id,
        )
        session.add(plan)
        await session.flush()
        run = new_run_row(
            target.id, plan.id, bundle.id, bundle.hash, user.id, status, read_only, budget
        )
        session.add(run)
        await session.flush()
        seeded = SeededRun(
            run_id=run.id,
            plan_id=plan.id,
            target_id=target.id,
            bundle_id=bundle.id,
            user_id=user.id,
        )
        if create_run_scenarios:
            for number in range(1, scenario_count + 1):
                document = scenario_document(
                    title=f"Scenario {number}",
                    timeout_seconds=scenario_timeout_seconds,
                    steps=steps_per_scenario,
                    adapter=adapter,
                )
                scenario = ScenarioRow(
                    target_id=target.id,
                    bundle_id=bundle.id,
                    feature_id="smart_log.read.open_issues",
                    title=document["title"],
                    family="smart-log",
                    origin=ScenarioOrigin.bundle_example,
                    status=ScenarioStatus.accepted,
                    version=1,
                    yaml=json.dumps(document),
                    parsed=document,
                    validation={"valid": True, "errors": [], "warnings": []},
                )
                session.add(scenario)
                await session.flush()
                run_scenario = RunScenarioRow(
                    run_id=run.id,
                    scenario_id=scenario.id,
                    scenario_version=1,
                    role="staff",
                    interface_id=f"chat-{number}",
                    attempts_total=attempts,
                    status=RunScenarioStatus.queued,
                    attempts=[
                        {"attempt": attempt, "status": "queued", "verdict": None}
                        for attempt in range(attempts)
                    ],
                )
                session.add(run_scenario)
                await session.flush()
                seeded.scenario_ids.append(scenario.id)
                seeded.run_scenario_ids.append(run_scenario.id)
        await session.commit()
    return seeded


async def load_run(session_factory: SessionFactory, run_id: uuid.UUID) -> RunRow:
    async with session_factory() as session:
        row = await session.get(RunRow, run_id)
        assert row is not None
        return row


async def load_run_scenarios(
    session_factory: SessionFactory, run_id: uuid.UUID
) -> list[RunScenarioRow]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(RunScenarioRow)
            .where(RunScenarioRow.run_id == run_id)
            .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
        )
        return list(rows)


async def load_run_scenario(
    session_factory: SessionFactory, run_scenario_id: uuid.UUID
) -> RunScenarioRow:
    async with session_factory() as session:
        row = await session.get(RunScenarioRow, run_scenario_id)
        assert row is not None
        return row


async def load_steps(session_factory: SessionFactory, run_id: uuid.UUID) -> list[StepRow]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(StepRow).where(StepRow.run_id == run_id).order_by(StepRow.attempt, StepRow.index)
        )
        return list(rows)


def verdict_status(row: RunScenarioRow) -> str | None:
    return None if row.verdict is None else str(row.verdict["status"])


@dataclass
class RecordedEvent:
    run_id: uuid.UUID | None
    type: str
    dedupe_key: str | None
    payload: dict[str, Any]
    seq: int | None


class RecordingIngest:
    def __init__(self) -> None:
        self.requests: list[list[IngestEvent]] = []
        self.events: list[RecordedEvent] = []
        self.failures_before_success = 0
        self.failure_status = 503
        self.attempts = 0
        self.rejected_status: int | None = None
        self.seen: dict[tuple[uuid.UUID, str], int] = {}
        self.head: dict[uuid.UUID, int] = defaultdict(int)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.attempts += 1
        if self.rejected_status is not None:
            return httpx.Response(self.rejected_status, json={"error": {"code": "rejected"}})
        if self.failures_before_success > 0:
            self.failures_before_success -= 1
            return httpx.Response(self.failure_status)
        batch = IngestEventBatch.model_validate(json.loads(request.content))
        self.requests.append(list(batch.events))
        seqs: list[int | None] = []
        accepted = 0
        for event in batch.events:
            seq = self.record(event)
            seqs.append(seq)
            accepted += 1
        result = IngestEventResult(accepted=accepted, deduplicated=0, seqs=seqs)
        return httpx.Response(200, json=result.model_dump(mode="json"))

    def record(self, event: IngestEvent) -> int | None:
        if event.run_id is None or event.dedupe_key is None:
            self.events.append(RecordedEvent(event.run_id, event.type, None, event.payload, None))
            return None
        key = (event.run_id, event.dedupe_key)
        known = self.seen.get(key)
        if known is not None:
            return known
        self.head[event.run_id] += 1
        seq = self.head[event.run_id]
        self.seen[key] = seq
        self.events.append(
            RecordedEvent(event.run_id, event.type, event.dedupe_key, event.payload, seq)
        )
        return seq

    @property
    def types(self) -> list[str]:
        return [event.type for event in self.events]

    def of_type(self, event_type: str) -> list[RecordedEvent]:
        return [event for event in self.events if event.type == event_type]

    def status_changes(self) -> list[tuple[str, str, str | None]]:
        return [
            (event.payload["previous"], event.payload["status"], event.payload["reason"])
            for event in self.of_type("run.status_changed")
        ]

    def seqs_for(self, run_id: uuid.UUID) -> list[int]:
        return [
            event.seq for event in self.events if event.run_id == run_id and event.seq is not None
        ]


async def create_plan_through_api(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    target_id: uuid.UUID,
    feature_ids: list[str],
    roles: list[str] | None = None,
    interface_mode: str = "both",
    k: int = 1,
) -> uuid.UUID:
    response = await client.post(
        "/api/v1/plans",
        json={
            "target_id": str(target_id),
            "saved": True,
            "selection": {
                "feature_ids": feature_ids,
                "area_ids": [],
                "roles": roles if roles is not None else ["all"],
                "interface_mode": interface_mode,
                "depth": "smoke",
                "k": k,
            },
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return uuid.UUID(response.json()["id"])


async def insert_run_for_plan(
    session_factory: SessionFactory,
    target_id: uuid.UUID,
    bundle_id: uuid.UUID,
    plan_id: uuid.UUID,
    user_id: uuid.UUID,
    read_only: bool = False,
) -> uuid.UUID:
    async with session_factory() as session:
        bundle = await session.get(BundleRow, bundle_id)
        assert bundle is not None
        run = new_run_row(target_id, plan_id, bundle_id, bundle.hash, user_id, read_only=read_only)
        session.add(run)
        await session.commit()
        return run.id
