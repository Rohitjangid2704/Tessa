import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import update
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow, ScenarioRow, StepRow
from tessa_api.schemas.enums import (
    RunKind,
    RunScenarioStatus,
    RunStatus,
    RunTrigger,
    ScenarioOrigin,
    ScenarioStatus,
    Tier0Check,
)
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.schemas.steps import Tier0Result
from tessa_api.schemas.temporal import RunTier0ChecksInput
from tessa_worker.activities.tier0 import Tier0Activities, record_from_row
from tessa_worker.adapters.base import StepRecord
from tessa_worker.adapters.sse import SseAdapter
from tessa_worker.checks.internal_ids import build_tier0_context
from tessa_worker.checks.tier0 import evaluate_tier0
from tests.adapters.support import RegisteredTarget
from tests.adapters.test_sse_adapter import chat

OPEN_ISSUES = "Which maintenance issues are still open?"
LEAK = "What is the internal id of room 20003?"


def scenario_document(*expects: dict[str, Any]) -> ScenarioDoc:
    return ScenarioDoc.model_validate(
        {
            "schema_version": 1,
            "title": "Chat checks",
            "feature_id": "maintenance.read.open_issues",
            "family": "maintenance",
            "role": "manager",
            "interface_id": "chat_sse",
            "steps": [
                {
                    "adapter": "sse",
                    "request": {"method": "POST", "path": "/message", "body": {"message": "x"}},
                    "expect": expect,
                }
                for expect in expects
            ],
        }
    )


async def record_chat(registered: RegisteredTarget, message: str) -> StepRecord:
    adapter = SseAdapter(registered.context("manager", "chat_sse"))
    try:
        return await adapter.drive(chat(message))
    finally:
        await adapter.close()


async def insert_scenario(registered: RegisteredTarget, document: ScenarioDoc) -> uuid.UUID:
    row = ScenarioRow(
        target_id=registered.target_id,
        bundle_id=registered.bundle_id,
        feature_id=document.feature_id,
        title=document.title,
        family=document.family,
        origin=ScenarioOrigin.bundle_example,
        status=ScenarioStatus.accepted,
        yaml="",
        parsed=document.model_dump(mode="json", by_alias=True),
        validation={"valid": True, "errors": [], "warnings": []},
    )
    async with registered.session_factory() as session:
        session.add(row)
        await session.commit()
    return row.id


async def insert_run(registered: RegisteredTarget, scenario_id: uuid.UUID) -> RunScenarioRow:
    run = RunRow(
        kind=RunKind.suite,
        target_id=registered.target_id,
        bundle_id=registered.bundle_id,
        status=RunStatus.running,
        trigger=RunTrigger.manual,
        config_snapshot={},
        budget={"max_usd": 5, "max_minutes": 30},
        counters={},
        workflow_id=f"execute-run-{uuid.uuid4()}",
        created_by=registered.user_id,
    )
    async with registered.session_factory() as session:
        session.add(run)
        await session.flush()
        run_scenario = RunScenarioRow(
            run_id=run.id,
            scenario_id=scenario_id,
            scenario_version=1,
            role="manager",
            interface_id="chat_sse",
            attempts_total=1,
            status=RunScenarioStatus.running,
        )
        session.add(run_scenario)
        await session.commit()
    return run_scenario


def step_row(run_scenario: RunScenarioRow, record: StepRecord, index: int) -> StepRow:
    return StepRow(
        run_scenario_id=run_scenario.id,
        run_id=run_scenario.run_id,
        attempt=0,
        index=index,
        adapter=record.adapter,
        label=record.label,
        request=record.request.model_dump(mode="json"),
        response=record.response.model_dump(mode="json") if record.response else None,
        response_truncated=record.response_truncated,
        ask=record.ask,
        answer=record.answer,
        tools=[tool.model_dump(mode="json") for tool in record.tools],
        cards=record.cards,
        tier0={"passed": True, "failures": []},
        latency_ms=record.latency_ms,
        cost_usd=Decimal(str(record.cost_usd)),
        artifacts=[],
        ok=record.ok,
        started_at=record.started_at,
        finished_at=datetime.now(UTC),
    )


async def insert_step(
    registered: RegisteredTarget, run_scenario: RunScenarioRow, record: StepRecord, index: int = 0
) -> uuid.UUID:
    row = step_row(run_scenario, record, index)
    async with registered.session_factory() as session:
        session.add(row)
        await session.commit()
    return row.id


async def run_activity(registered: RegisteredTarget, step_id: uuid.UUID) -> Tier0Result:
    activities = Tier0Activities(registered.session_factory)
    return await ActivityEnvironment().run(
        activities.run_tier0_checks, RunTier0ChecksInput(step_id=step_id)
    )


async def test_the_activity_recomputes_the_inline_result_from_the_stored_step(
    registered: RegisteredTarget,
) -> None:
    expect = {
        "status": 200,
        "tools": {"include": ["query_issues"]},
        "cards": {"min_count": 1},
        "text_contains": ["3 maintenance issues"],
        "latency": {"max_ms": 10000},
    }
    document = scenario_document(expect)
    record = await record_chat(registered, OPEN_ISSUES)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record)
    inline = evaluate_tier0(
        record, document.steps[0].expect, build_tier0_context(registered.manifest)
    )
    stored = await run_activity(registered, step_id)
    assert inline.passed is True
    assert stored == inline


async def test_a_failing_check_is_recomputed_with_the_same_failures(
    registered: RegisteredTarget,
) -> None:
    document = scenario_document({"text_contains": ["not in the answer"], "tools": {"none": True}})
    record = await record_chat(registered, OPEN_ISSUES)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record)
    inline = evaluate_tier0(
        record, document.steps[0].expect, build_tier0_context(registered.manifest)
    )
    stored = await run_activity(registered, step_id)
    assert stored.passed is False
    assert stored == inline
    assert [failure.check for failure in stored.failures] == [
        Tier0Check.tools,
        Tier0Check.text_contains,
    ]


async def test_the_step_is_matched_to_its_scenario_step_by_index(
    registered: RegisteredTarget,
) -> None:
    document = scenario_document(
        {"text_contains": ["3 maintenance issues"]}, {"tools": {"none": True}}
    )
    record = await record_chat(registered, OPEN_ISSUES)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    first = await insert_step(registered, run_scenario, record, index=0)
    second = await insert_step(registered, run_scenario, record, index=1)
    assert (await run_activity(registered, first)).passed is True
    assert (await run_activity(registered, second)).passed is False


async def test_the_bundle_internal_id_patterns_are_applied(registered: RegisteredTarget) -> None:
    document = scenario_document({"non_empty_answer": True})
    record = await record_chat(registered, LEAK)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record)
    stored = await run_activity(registered, step_id)
    assert [failure.check for failure in stored.failures] == [Tier0Check.internal_ids]


async def test_the_stored_record_round_trips_through_the_row(registered: RegisteredTarget) -> None:
    record = await record_chat(registered, OPEN_ISSUES)
    document = scenario_document({})
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record)
    async with registered.session_factory() as session:
        row = await session.get(StepRow, step_id)
    assert row is not None
    rebuilt = record_from_row(row)
    assert rebuilt.request == record.request
    assert rebuilt.response == record.response
    assert rebuilt.answer == record.answer
    assert rebuilt.tools == record.tools
    assert rebuilt.cards == record.cards
    assert rebuilt.ok == record.ok


async def expect_permanent_failure(
    registered: RegisteredTarget, step_id: uuid.UUID, message: str
) -> None:
    with pytest.raises(ApplicationError, match=message) as caught:
        await run_activity(registered, step_id)
    assert caught.value.non_retryable is True


async def test_an_unknown_step_is_a_permanent_failure(registered: RegisteredTarget) -> None:
    await expect_permanent_failure(registered, uuid.uuid4(), "does not exist")


async def test_a_step_beyond_the_scenario_is_a_permanent_failure(
    registered: RegisteredTarget,
) -> None:
    document = scenario_document({})
    record = await record_chat(registered, OPEN_ISSUES)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record, index=5)
    await expect_permanent_failure(registered, step_id, "fewer steps")


async def test_a_purged_step_is_a_permanent_failure(registered: RegisteredTarget) -> None:
    document = scenario_document({})
    record = await record_chat(registered, OPEN_ISSUES)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record)
    async with registered.session_factory() as session:
        await session.execute(update(StepRow).where(StepRow.id == step_id).values(request=None))
        await session.commit()
    await expect_permanent_failure(registered, step_id, "purged")


async def test_a_step_of_another_adapter_kind_than_its_scenario_step_is_permanent(
    registered: RegisteredTarget,
) -> None:
    document = scenario_document({})
    record = await record_chat(registered, OPEN_ISSUES)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record)
    async with registered.session_factory() as session:
        await session.execute(
            update(StepRow)
            .where(StepRow.id == step_id)
            .values(
                adapter="http",
                request={
                    "kind": "http",
                    "method": "GET",
                    "url": "http://t/x",
                    "headers": {},
                    "query": None,
                    "body": None,
                },
                response=None,
            )
        )
        await session.commit()
    await expect_permanent_failure(registered, step_id, "cannot be evaluated")


async def test_a_bundle_without_a_manifest_is_a_permanent_failure(
    registered: RegisteredTarget,
) -> None:
    document = scenario_document({})
    record = await record_chat(registered, OPEN_ISSUES)
    run_scenario = await insert_run(registered, await insert_scenario(registered, document))
    step_id = await insert_step(registered, run_scenario, record)
    async with registered.session_factory() as session:
        await session.execute(
            update(BundleRow).where(BundleRow.id == registered.bundle_id).values(manifest=None)
        )
        await session.commit()
    await expect_permanent_failure(registered, step_id, "no manifest")
