import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

import httpx
import pytest
from sqlalchemy import select
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from tessa_api.db.models import ProbeResultRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import JudgeOrder, ProbeStatus, VerdictStatus, VerdictTier
from tessa_api.schemas.grading import GradePolicy
from tessa_api.schemas.oracles import GoldPoint
from tessa_api.schemas.temporal import GRADE_STEP_WORKFLOW, GradeStepInput, GradeStepResult
from tessa_api.services.artifact_store import InMemoryArtifactStore
from tessa_api.services.storage import LocalBundleStore
from tessa_worker.grading.escalation import JUDGE_DISABLED, JUDGE_UNAVAILABLE
from tessa_worker.grading.judge_store import stored_evidence
from tessa_worker.main import WorkerServices, build_activities
from tessa_worker.settings import WorkerSettings
from tessa_worker.workflows.grade_step import GradeStepWorkflow
from tests.grading.support import (
    ANSWER,
    ASK,
    GOLD_RENDERED,
    SeededStep,
    gold_point,
    judge_rows,
    manifest_with_feature_invariants,
    seed_step,
)
from tests.runs.drive_support import FakeOpener
from tests.runs.support import RecordingIngest
from tests.support import TEST_LAYA_URL

pytestmark = pytest.mark.integration

TASK_QUEUE = "tessa-test-worker-grade-step"
UNREACHABLE_LAYA = TEST_LAYA_URL
POLICY = GradePolicy(probe_confidence=0.75, judge_escalate_below=0.6, tiebreak_enabled=True)
STATED_ANSWER = f"Yes, {GOLD_RENDERED} right now."


def grading_settings(worker_settings: WorkerSettings, stub_models: bool) -> WorkerSettings:
    return worker_settings.model_copy(
        update={
            "laya_url": UNREACHABLE_LAYA,
            "laya_timeout_seconds": 1,
            "stub_models": stub_models,
        }
    )


@asynccontextmanager
async def grading_worker(
    environment: WorkflowEnvironment,
    settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> AsyncIterator[None]:
    async with (
        httpx.AsyncClient(transport=httpx.MockTransport(ingest.handle)) as api_http,
        httpx.AsyncClient() as laya_http,
    ):
        services = WorkerServices(
            settings=settings,
            api_http=api_http,
            laya_http=laya_http,
            session_factory=session_factory,
            adapters=FakeOpener(),
            artifacts=InMemoryArtifactStore(),
            bundles=LocalBundleStore(settings.data_dir),
        )
        async with Worker(
            environment.client,
            task_queue=TASK_QUEUE,
            workflows=[GradeStepWorkflow],
            activities=build_activities(services),
        ):
            yield


async def seed_graded_step(
    session_factory: SessionFactory,
    answer: str | None = ANSWER,
    ask: str | None = ASK,
    gold_points: Sequence[GoldPoint] = (),
) -> SeededStep:
    return await seed_step(
        session_factory,
        answer=answer,
        ask=ask,
        gold_points=gold_points,
        manifest=manifest_with_feature_invariants(),
    )


async def grade(
    environment: WorkflowEnvironment, seeded: SeededStep, policy: GradePolicy = POLICY
) -> GradeStepResult:
    result: GradeStepResult = await environment.client.execute_workflow(
        GRADE_STEP_WORKFLOW,
        GradeStepInput(step_id=seeded.step_id, run_id=seeded.run_id, policy=policy),
        id=f"grade-step-test-{uuid.uuid4()}",
        task_queue=TASK_QUEUE,
        result_type=GradeStepResult,
    )
    return result


async def probe_statuses(session_factory: SessionFactory, step_id: uuid.UUID) -> set[ProbeStatus]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(ProbeResultRow.status).where(ProbeResultRow.step_id == step_id)
        )
        return set(rows)


async def stored_verdict_status(session_factory: SessionFactory, step_id: uuid.UUID) -> str:
    async with session_factory() as session:
        step = await session.get(StepRow, step_id)
        assert step is not None
        assert step.verdict is not None
        return str(step.verdict["status"])


async def test_with_laya_unreachable_the_step_is_judged_and_never_passed_by_code_or_laya(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_graded_step(
        session_factory, answer=STATED_ANSWER, gold_points=[gold_point()]
    )
    settings = grading_settings(worker_settings, stub_models=True)
    async with grading_worker(temporal_env, settings, session_factory, ingest):
        result = await grade(temporal_env, seeded)
    assert await probe_statuses(session_factory, seeded.step_id) == {ProbeStatus.error}
    assert result.verdict.status is VerdictStatus.pass_
    assert result.verdict.tier is VerdictTier.judge
    assert result.escalated_to is VerdictTier.judge
    [paired] = await judge_rows(session_factory, seeded.step_id)
    assert [call.order for call in stored_evidence(paired).billing.calls] == [
        JudgeOrder.a_b,
        JudgeOrder.b_a,
    ]
    assert await stored_verdict_status(session_factory, seeded.step_id) == "pass"
    assert "step.graded" in ingest.types


async def test_with_laya_unreachable_and_no_judge_key_the_step_ends_uncertain(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_graded_step(session_factory, gold_points=[gold_point()])
    settings = grading_settings(worker_settings, stub_models=False)
    async with grading_worker(temporal_env, settings, session_factory, ingest):
        result = await grade(temporal_env, seeded)
    assert result.verdict.status is VerdictStatus.uncertain
    assert result.verdict.reason_code == JUDGE_UNAVAILABLE
    assert result.verdict.tier is VerdictTier.laya
    assert await judge_rows(session_factory, seeded.step_id) == []
    assert await stored_verdict_status(session_factory, seeded.step_id) == "uncertain"


async def test_with_laya_unreachable_and_the_judge_switched_off_the_step_ends_uncertain(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_graded_step(session_factory, gold_points=[gold_point()])
    settings = grading_settings(worker_settings, stub_models=True)
    async with grading_worker(temporal_env, settings, session_factory, ingest):
        result = await grade(temporal_env, seeded, POLICY.without_judge())
    assert result.verdict.status is VerdictStatus.uncertain
    assert result.verdict.reason_code == JUDGE_DISABLED
    assert result.spent_usd == 0.0
    assert await judge_rows(session_factory, seeded.step_id) == []


async def test_with_laya_unreachable_a_judge_without_a_reference_ends_uncertain(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_graded_step(session_factory)
    settings = grading_settings(worker_settings, stub_models=True)
    async with grading_worker(temporal_env, settings, session_factory, ingest):
        result = await grade(temporal_env, seeded)
    assert result.verdict.status is VerdictStatus.uncertain
    assert result.verdict.tier is VerdictTier.judge
    assert result.escalated_to is VerdictTier.judge


async def test_a_step_without_free_text_is_graded_by_code_without_asking_laya(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_graded_step(session_factory, answer=None, ask=None)
    settings = grading_settings(worker_settings, stub_models=True)
    async with grading_worker(temporal_env, settings, session_factory, ingest):
        result = await grade(temporal_env, seeded)
    assert await probe_statuses(session_factory, seeded.step_id) == set()
    assert result.verdict.status is VerdictStatus.pass_
    assert result.verdict.tier is VerdictTier.code
    assert result.escalated_to is None
