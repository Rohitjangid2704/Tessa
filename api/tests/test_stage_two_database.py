import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import Connection, func, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from tessa_api.db.models import (
    BrowserSessionRow,
    CoverageCellRow,
    PlanRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    StepRow,
    User,
)
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    AdapterKind,
    BrowserSessionStatus,
    CellStatus,
    Depth,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    RunTrigger,
    ScenarioOrigin,
    ScenarioStatus,
    SkipReason,
    UserRole,
    VerdictStatus,
)
from tessa_api.settings import Settings
from tests.stage_one import create_target, insert_bundle, sample_manifest
from tests.support import AuthHeaders, MakeUser

pytestmark = pytest.mark.integration

STAGE_TWO_TABLES = {
    "plans",
    "coverage_cells",
    "scenarios",
    "runs",
    "run_scenarios",
    "steps",
    "browser_sessions",
}

EXPECTED_COLUMNS: dict[str, set[str]] = {
    "plans": {
        "id",
        "target_id",
        "bundle_id",
        "name",
        "saved",
        "selection",
        "depth",
        "k",
        "budget",
        "created_by",
        "created_at",
        "is_coverage_baseline",
        "include_api_fuzz",
        "schedule_id",
    },
    "coverage_cells": {
        "id",
        "plan_id",
        "feature_id",
        "role",
        "interface_id",
        "family",
        "status",
        "last_verdict",
        "reason",
        "skip_reason",
    },
    "scenarios": {
        "id",
        "target_id",
        "bundle_id",
        "feature_id",
        "cell_id",
        "title",
        "family",
        "origin",
        "status",
        "version",
        "yaml",
        "parsed",
        "validation",
        "provenance",
        "embedding",
        "created_at",
        "updated_at",
    },
    "runs": {
        "id",
        "kind",
        "target_id",
        "plan_id",
        "bundle_id",
        "status",
        "trigger",
        "read_only",
        "config_snapshot",
        "budget",
        "spent_usd",
        "counters",
        "workflow_id",
        "event_head_seq",
        "created_by",
        "created_at",
        "started_at",
        "finished_at",
        "stats",
        "stop_requested_at",
    },
    "run_scenarios": {
        "id",
        "run_id",
        "scenario_id",
        "scenario_version",
        "role",
        "interface_id",
        "attempts_total",
        "status",
        "verdict",
        "skip_reason",
        "attempts",
        "created_at",
        "started_at",
        "finished_at",
    },
    "steps": {
        "id",
        "run_scenario_id",
        "run_id",
        "attempt",
        "index",
        "adapter",
        "label",
        "request",
        "response",
        "response_truncated",
        "ask",
        "answer",
        "tools",
        "cards",
        "tier0",
        "latency_ms",
        "cost_usd",
        "artifacts",
        "verdict",
        "ok",
        "tier0_failure_count",
        "screenshot_count",
        "gold_points",
        "db_checks",
        "evidence",
        "machine_grading",
        "payload_purged_at",
        "started_at",
        "finished_at",
    },
    "browser_sessions": {
        "id",
        "run_id",
        "run_scenario_id",
        "attempt",
        "status",
        "viewport",
        "last_url",
        "recording",
        "trace",
        "started_at",
        "ended_at",
    },
}

UNIQUE_COLUMNS: dict[str, set[tuple[str, ...]]] = {
    "coverage_cells": {("plan_id", "feature_id", "role", "interface_id")},
    "run_scenarios": {("run_id", "scenario_id", "role", "interface_id")},
    "steps": {("run_scenario_id", "attempt", "index")},
    "runs": {("workflow_id",)},
}

NULLABLE_COLUMNS = {
    "plans": {"name", "schedule_id"},
    "coverage_cells": {"last_verdict", "reason", "skip_reason"},
    "scenarios": {"feature_id", "cell_id", "provenance", "embedding"},
    "runs": {
        "target_id",
        "plan_id",
        "bundle_id",
        "started_at",
        "finished_at",
        "stats",
        "stop_requested_at",
    },
    "run_scenarios": {"verdict", "skip_reason", "started_at", "finished_at"},
    "steps": {
        "request",
        "response",
        "ask",
        "answer",
        "verdict",
        "ok",
        "evidence",
        "machine_grading",
        "payload_purged_at",
    },
    "browser_sessions": {"last_url", "recording", "trace", "ended_at"},
}

EXPECTED_INDEXES = {
    "plans": {"ix_plans_target_id_created_at": ["target_id", "created_at"]},
    "scenarios": {"ix_scenarios_target_id_feature_id": ["target_id", "feature_id"]},
    "runs": {
        "ix_runs_target_id_created_at": ["target_id", "created_at"],
        "ix_runs_status_non_terminal": ["status"],
    },
    "run_scenarios": {"ix_run_scenarios_run_id": ["run_id"]},
    "steps": {"ix_steps_run_id": ["run_id"]},
    "browser_sessions": {"ix_browser_sessions_run_id": ["run_id"]},
}

NON_TERMINAL = ("queued", "planning", "seeding", "running", "canceling")
TERMINAL = ("completed", "failed", "canceled", "budget_exceeded")

CollectedTable = dict[str, Any]


async def collect(settings: Settings, table: str) -> CollectedTable:
    engine = create_async_engine(settings.database_url.get_secret_value())

    def read(connection: Connection) -> CollectedTable:
        tessa = inspect(connection)
        return {
            "columns": {column["name"]: column for column in tessa.get_columns(table)},
            "unique": tessa.get_unique_constraints(table),
            "indexes": tessa.get_indexes(table),
            "foreign_keys": tessa.get_foreign_keys(table),
        }

    try:
        async with engine.connect() as connection:
            return await connection.run_sync(read)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("table", sorted(STAGE_TWO_TABLES))
async def test_a_table_has_exactly_the_contract_columns(
    settings: Settings, migrated_database: None, table: str
) -> None:
    collected = await collect(settings, table)
    assert set(collected["columns"]) == EXPECTED_COLUMNS[table]


@pytest.mark.parametrize("table", sorted(NULLABLE_COLUMNS))
async def test_nullability_follows_the_contract(
    settings: Settings, migrated_database: None, table: str
) -> None:
    columns = (await collect(settings, table))["columns"]
    nullable = {name for name, column in columns.items() if column["nullable"]}
    assert nullable == NULLABLE_COLUMNS[table]


@pytest.mark.parametrize("table", sorted(UNIQUE_COLUMNS))
async def test_unique_constraints_exist(
    settings: Settings, migrated_database: None, table: str
) -> None:
    collected = await collect(settings, table)
    found = {tuple(constraint["column_names"]) for constraint in collected["unique"]}
    assert UNIQUE_COLUMNS[table] <= found


@pytest.mark.parametrize("table", sorted(EXPECTED_INDEXES))
async def test_the_plan_indexes_exist(
    settings: Settings, migrated_database: None, table: str
) -> None:
    indexes = {index["name"]: index for index in (await collect(settings, table))["indexes"]}
    for name, columns in EXPECTED_INDEXES[table].items():
        assert indexes[name]["column_names"] == columns


async def test_the_runs_status_index_is_partial_and_covers_only_open_statuses(
    settings: Settings, migrated_database: None
) -> None:
    indexes = {index["name"]: index for index in (await collect(settings, "runs"))["indexes"]}
    predicate = indexes["ix_runs_status_non_terminal"]["dialect_options"]["postgresql_where"]
    for status in NON_TERMINAL:
        assert f"'{status}'" in predicate
    for status in TERMINAL:
        assert f"'{status}'" not in predicate


async def test_the_runs_list_index_sorts_newest_first(
    settings: Settings, migrated_database: None
) -> None:
    indexes = {index["name"]: index for index in (await collect(settings, "runs"))["indexes"]}
    assert indexes["ix_runs_target_id_created_at"]["column_sorting"] == {"created_at": ("desc",)}


async def test_scenario_embeddings_are_a_1536_dimension_vector_with_one_hnsw_index(
    settings: Settings, migrated_database: None
) -> None:
    collected = await collect(settings, "scenarios")
    assert "VECTOR(1536)" in str(collected["columns"]["embedding"]["type"]).upper()
    embedding_indexes = [
        index for index in collected["indexes"] if "embedding" in index["column_names"]
    ]
    assert [index["name"] for index in embedding_indexes] == ["ix_scenarios_embedding_hnsw"]
    assert embedding_indexes[0]["dialect_options"]["postgresql_using"] == "hnsw"


async def test_the_foreign_keys_cascade_or_clear_as_designed(
    settings: Settings, migrated_database: None
) -> None:
    def rules(collected: CollectedTable) -> dict[str, str | None]:
        return {
            key["referred_table"]: key["options"].get("ondelete")
            for key in collected["foreign_keys"]
        }

    assert rules(await collect(settings, "coverage_cells")) == {"plans": "CASCADE"}
    assert rules(await collect(settings, "run_scenarios"))["runs"] == "CASCADE"
    steps = rules(await collect(settings, "steps"))
    assert steps == {"run_scenarios": "CASCADE", "runs": "CASCADE"}
    sessions = rules(await collect(settings, "browser_sessions"))
    assert sessions == {"run_scenarios": "CASCADE", "runs": "CASCADE"}
    assert rules(await collect(settings, "runs"))["plans"] == "SET NULL"
    assert rules(await collect(settings, "scenarios"))["coverage_cells"] == "SET NULL"


@pytest.fixture
async def chain(
    db_app: FastAPI,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> dict[str, Any]:
    user: User = await make_user(UserRole.member)
    target = await create_target(client, auth_headers(user))
    bundle = await insert_bundle(db_app, target["id"], user.id, sample_manifest())
    return {
        "app": db_app,
        "user_id": user.id,
        "target_id": uuid.UUID(target["id"]),
        "bundle_id": bundle.id,
    }


def build_rows(chain: dict[str, Any]) -> dict[str, Any]:
    plan = PlanRow(
        id=new_id(),
        target_id=chain["target_id"],
        bundle_id=chain["bundle_id"],
        name="Smoke",
        saved=True,
        selection={"feature_ids": ["a.b"], "k": 2},
        depth=Depth.smoke,
        k=2,
        budget={"max_usd": 5.0, "max_minutes": 30},
        created_by=chain["user_id"],
    )
    cell = CoverageCellRow(
        id=new_id(),
        plan_id=plan.id,
        feature_id="a.b",
        role="staff",
        interface_id="chat_sse",
        family="area",
        status=CellStatus.generated,
        last_verdict=VerdictStatus.flaky,
    )
    scenario = ScenarioRow(
        id=new_id(),
        target_id=chain["target_id"],
        bundle_id=chain["bundle_id"],
        feature_id="a.b",
        cell_id=cell.id,
        title="Ask",
        family="area",
        origin=ScenarioOrigin.bundle_example,
        status=ScenarioStatus.accepted,
        yaml="schema_version: 1\n",
        parsed={"schema_version": 1},
        validation={"valid": True, "errors": [], "warnings": []},
        embedding=[0.5] * 1536,
    )
    run = RunRow(
        id=new_id(),
        kind=RunKind.suite,
        target_id=chain["target_id"],
        plan_id=plan.id,
        bundle_id=chain["bundle_id"],
        status=RunStatus.queued,
        trigger=RunTrigger.manual,
        config_snapshot={"bundle_version": 1},
        budget={"max_usd": 5.0, "max_minutes": 30},
        counters={"scenarios_total": 1},
        workflow_id="execute-run-test",
        created_by=chain["user_id"],
    )
    run_scenario = RunScenarioRow(
        id=new_id(),
        run_id=run.id,
        scenario_id=scenario.id,
        scenario_version=1,
        role="staff",
        interface_id="chat_sse",
        attempts_total=2,
        status=RunScenarioStatus.queued,
    )
    step = StepRow(
        run_scenario_id=run_scenario.id,
        run_id=run.id,
        attempt=0,
        index=0,
        adapter=AdapterKind.sse,
        label="ask",
        tier0={"passed": True, "failures": []},
        latency_ms=120,
        cost_usd=Decimal("0.123456"),
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
    )
    session = BrowserSessionRow(
        run_id=run.id,
        run_scenario_id=run_scenario.id,
        attempt=0,
        status=BrowserSessionStatus.active,
        viewport={"width": 1280, "height": 720},
    )
    return {
        "plan": plan,
        "cell": cell,
        "scenario": scenario,
        "run": run,
        "run_scenario": run_scenario,
        "step": step,
        "session": session,
    }


async def persist(chain: dict[str, Any]) -> dict[str, Any]:
    rows = build_rows(chain)
    async with chain["app"].state.session_factory() as session:
        session.add(rows["plan"])
        await session.flush()
        session.add(rows["cell"])
        await session.flush()
        session.add_all([rows["scenario"], rows["run"]])
        await session.flush()
        session.add(rows["run_scenario"])
        await session.flush()
        session.add_all([rows["step"], rows["session"]])
        await session.commit()
    return rows


async def test_a_full_chain_of_rows_round_trips_through_the_models(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    async with chain["app"].state.session_factory() as session:
        run = await session.get(RunRow, rows["run"].id)
        step = await session.get(StepRow, rows["step"].id)
        scenario = await session.get(ScenarioRow, rows["scenario"].id)
        plan = await session.get(PlanRow, rows["plan"].id)
        cell = await session.get(CoverageCellRow, rows["cell"].id)
        browser = await session.get(BrowserSessionRow, rows["session"].id)
    assert run is not None
    assert run.status is RunStatus.queued
    assert run.read_only is False
    assert run.spent_usd == Decimal("0")
    assert run.event_head_seq == 0
    assert run.created_at.tzinfo is not None
    assert run.config_snapshot == {"bundle_version": 1}
    assert step is not None
    assert step.cost_usd == Decimal("0.123456")
    assert step.tools == []
    assert step.cards == []
    assert step.artifacts == []
    assert step.response_truncated is False
    assert (step.ok, step.tier0_failure_count, step.screenshot_count) == (None, 0, 0)
    assert step.adapter is AdapterKind.sse
    assert scenario is not None
    assert scenario.version == 1
    assert scenario.embedding is not None
    assert len(scenario.embedding) == 1536
    assert scenario.updated_at is not None
    assert plan is not None
    assert (plan.saved, plan.depth, plan.k, plan.schedule_id) == (True, Depth.smoke, 2, None)
    assert (plan.is_coverage_baseline, plan.include_api_fuzz) == (False, False)
    assert cell is not None
    assert cell.status is CellStatus.generated
    assert cell.last_verdict is VerdictStatus.flaky
    assert browser is not None
    assert browser.status is BrowserSessionStatus.active
    assert browser.viewport == {"width": 1280, "height": 720}


async def test_scenario_embeddings_may_stay_null(chain: dict[str, Any]) -> None:
    rows = build_rows(chain)
    rows["scenario"].embedding = None
    async with chain["app"].state.session_factory() as session:
        session.add_all([rows["plan"]])
        await session.flush()
        session.add(rows["cell"])
        await session.flush()
        session.add(rows["scenario"])
        await session.commit()
        stored = await session.scalar(select(ScenarioRow.embedding))
    assert stored is None


async def test_money_keeps_six_decimals(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    async with chain["app"].state.session_factory() as session:
        step = await session.get(StepRow, rows["step"].id)
        assert step is not None
        step.cost_usd = Decimal("0.0000019")
        await session.commit()
        await session.refresh(step)
    assert step.cost_usd == Decimal("0.000002")


async def test_duplicates_violate_the_unique_constraints(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    duplicate_cell = CoverageCellRow(
        plan_id=rows["plan"].id,
        feature_id="a.b",
        role="staff",
        interface_id="chat_sse",
        family="x",
        status=CellStatus.empty,
    )
    duplicate_run_scenario = RunScenarioRow(
        run_id=rows["run"].id,
        scenario_id=rows["scenario"].id,
        scenario_version=1,
        role="staff",
        interface_id="chat_sse",
        attempts_total=1,
        status=RunScenarioStatus.queued,
    )
    duplicate_step = StepRow(
        run_scenario_id=rows["run_scenario"].id,
        run_id=rows["run"].id,
        attempt=0,
        index=0,
        adapter=AdapterKind.sse,
        label="again",
        tier0={"passed": True, "failures": []},
        latency_ms=1,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
    )
    for duplicate in (duplicate_cell, duplicate_run_scenario, duplicate_step):
        async with chain["app"].state.session_factory() as session:
            session.add(duplicate)
            with pytest.raises(IntegrityError):
                await session.commit()


async def test_a_step_of_another_attempt_or_index_is_not_a_duplicate(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    siblings = [
        StepRow(
            run_scenario_id=rows["run_scenario"].id,
            run_id=rows["run"].id,
            attempt=attempt,
            index=index,
            adapter=AdapterKind.sse,
            label="other",
            tier0={"passed": True, "failures": []},
            latency_ms=1,
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )
        for attempt, index in ((0, 1), (1, 0))
    ]
    async with chain["app"].state.session_factory() as session:
        session.add_all(siblings)
        await session.commit()
        count = await session.scalar(select(func.count()).select_from(StepRow))
    assert count == 3


async def test_deleting_a_run_removes_its_scenarios_steps_and_sessions(
    chain: dict[str, Any],
) -> None:
    rows = await persist(chain)
    async with chain["app"].state.session_factory() as session:
        run = await session.get(RunRow, rows["run"].id)
        assert run is not None
        await session.delete(run)
        await session.commit()
        for model in (RunScenarioRow, StepRow, BrowserSessionRow):
            assert await session.scalar(select(func.count()).select_from(model)) == 0
        assert await session.scalar(select(func.count()).select_from(ScenarioRow)) == 1


async def test_deleting_a_plan_removes_its_cells_and_detaches_runs_and_scenarios(
    chain: dict[str, Any],
) -> None:
    rows = await persist(chain)
    async with chain["app"].state.session_factory() as session:
        plan = await session.get(PlanRow, rows["plan"].id)
        assert plan is not None
        await session.delete(plan)
        await session.commit()
        assert await session.scalar(select(func.count()).select_from(CoverageCellRow)) == 0
        run = await session.get(RunRow, rows["run"].id)
        scenario = await session.get(ScenarioRow, rows["scenario"].id)
    assert run is not None
    assert run.plan_id is None
    assert scenario is not None
    assert scenario.cell_id is None


async def test_a_skipped_run_scenario_keeps_its_reason(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    async with chain["app"].state.session_factory() as session:
        run_scenario = await session.get(RunScenarioRow, rows["run_scenario"].id)
        assert run_scenario is not None
        run_scenario.status = RunScenarioStatus.skipped
        run_scenario.skip_reason = SkipReason.budget_exceeded
        run_scenario.verdict = {"status": "skipped", "skip_reason": "budget_exceeded"}
        await session.commit()
        await session.refresh(run_scenario)
    assert run_scenario.skip_reason is SkipReason.budget_exceeded
    assert run_scenario.attempts == []
