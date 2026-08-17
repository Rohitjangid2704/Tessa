import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import JudgeOrder, VerdictStatus
from tessa_api.schemas.grading import JudgeStepInput, JudgeStepOutput
from tessa_api.schemas.temporal import (
    JUDGE_MAX_ATTEMPTS,
    JUDGE_START_TO_CLOSE,
    JUDGE_STEP_ACTIVITY,
    JUDGE_TIEBREAK_ACTIVITY,
)
from tessa_worker.activities.judge import JudgeActivities, default_judge_activities
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.judge_verdict import REASON_OUTPUT_INVALID
from tessa_worker.settings import WorkerSettings
from tests.fakes.openai import (
    FakeProvider,
    anthropic_error,
    anthropic_reply,
    openai_error,
    openai_reply,
    valid_answer,
)
from tests.grading.judge_workflow import JUDGE_PROBE_WORKFLOW, JudgeProbeCall, JudgeProbeWorkflow
from tests.grading.support import (
    GOLD_KEY,
    FakeProviders,
    gold_point,
    judge_input,
    judge_rows,
    seed_step,
    tiebreak_spec,
)

pytestmark = pytest.mark.integration

TASK_QUEUE = "judge-activity-tests"
PASS_WITH_GOLD = valid_answer("pass", 0.9, gold_points_used=(GOLD_KEY,))


@pytest.fixture
def activities(
    worker_settings: WorkerSettings, session_factory: SessionFactory, providers: FakeProviders
) -> JudgeActivities:
    return default_judge_activities(worker_settings, session_factory, providers)


@asynccontextmanager
async def running(
    environment: WorkflowEnvironment, activities: JudgeActivities
) -> AsyncIterator[None]:
    async with Worker(
        environment.client,
        task_queue=TASK_QUEUE,
        workflows=[JudgeProbeWorkflow],
        activities=[
            activities.judge_step,
            activities.judge_tiebreak,
            activities.build_step_evidence,
        ],
    ):
        yield


async def execute(
    environment: WorkflowEnvironment, activity_name: str, request: JudgeStepInput
) -> JudgeStepOutput:
    output: JudgeStepOutput = await environment.client.execute_workflow(
        JUDGE_PROBE_WORKFLOW,
        JudgeProbeCall(activity_name=activity_name, request=request),
        id=f"judge-probe-{uuid.uuid4()}",
        task_queue=TASK_QUEUE,
        result_type=JudgeStepOutput,
    )
    return output


def failure_cause(error: WorkflowFailureError) -> ApplicationError:
    activity_error = error.cause
    assert isinstance(activity_error, ActivityError)
    cause = activity_error.cause
    assert isinstance(cause, ApplicationError)
    return cause


def test_the_contract_retry_budget_is_two_attempts_and_sixty_seconds() -> None:
    assert JUDGE_MAX_ATTEMPTS == 2
    assert JUDGE_START_TO_CLOSE.total_seconds() == 60


async def test_a_result_survives_the_temporal_payload_round_trip(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD))
    async with running(temporal_env, activities):
        output = await execute(temporal_env, JUDGE_STEP_ACTIVITY, judge_input(step.step_id))
    assert output.verdict.status is VerdictStatus.pass_
    row = (await judge_rows(session_factory, step.step_id))[0]
    assert output.judge_result_id == row.id
    assert output.cost_usd == pytest.approx(float(row.cost_usd))


async def test_a_rate_limit_is_retried_once_and_then_succeeds(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_openai(
        openai_error(429, "rate_limit_exceeded"), openai_reply(PASS_WITH_GOLD)
    )
    async with running(temporal_env, activities):
        output = await execute(temporal_env, JUDGE_STEP_ACTIVITY, judge_input(step.step_id))
    assert output.verdict.status is VerdictStatus.pass_
    assert len(fake_provider.openai_requests) == 2
    assert len(await judge_rows(session_factory, step.step_id)) == 1


async def test_two_failed_attempts_end_the_activity_and_no_third_call_is_made(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_openai(openai_error(503), openai_error(503), openai_reply(PASS_WITH_GOLD))
    async with running(temporal_env, activities):
        with pytest.raises(WorkflowFailureError) as caught:
            await execute(temporal_env, JUDGE_STEP_ACTIVITY, judge_input(step.step_id))
    assert failure_cause(caught.value).type == GradingErrorType.provider_unavailable
    assert len(fake_provider.openai_requests) == 2
    assert await judge_rows(session_factory, step.step_id) == []


@pytest.mark.parametrize("status", [400, 401, 403, 404])
async def test_a_rejected_request_is_not_retried(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    status: int,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_openai(openai_error(status), openai_reply(PASS_WITH_GOLD))
    async with running(temporal_env, activities):
        with pytest.raises(WorkflowFailureError) as caught:
            await execute(temporal_env, JUDGE_STEP_ACTIVITY, judge_input(step.step_id))
    assert failure_cause(caught.value).type == GradingErrorType.provider_rejected
    assert len(fake_provider.openai_requests) == 1


async def test_a_schema_violation_is_not_retried_and_ends_uncertain(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_openai(
        openai_reply({**valid_answer(), "override": True}), openai_reply(PASS_WITH_GOLD)
    )
    async with running(temporal_env, activities):
        output = await execute(temporal_env, JUDGE_STEP_ACTIVITY, judge_input(step.step_id))
    assert output.verdict.status is VerdictStatus.uncertain
    assert output.verdict.reason_code == REASON_OUTPUT_INVALID
    assert len(fake_provider.openai_requests) == 1


async def test_an_exhausted_budget_is_not_retried_and_makes_no_call(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(
        session_factory, gold_points=[gold_point()], budget_max_usd=1.0, spent_usd=1.0
    )
    async with running(temporal_env, activities):
        with pytest.raises(WorkflowFailureError) as caught:
            await execute(temporal_env, JUDGE_STEP_ACTIVITY, judge_input(step.step_id))
    assert failure_cause(caught.value).type == GradingErrorType.budget_exceeded
    assert fake_provider.request_count == 0


async def test_the_whole_position_swap_runs_through_temporal(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD), openai_reply(PASS_WITH_GOLD))
    async with running(temporal_env, activities):
        first = await execute(temporal_env, JUDGE_STEP_ACTIVITY, judge_input(step.step_id))
        second = await execute(
            temporal_env,
            JUDGE_STEP_ACTIVITY,
            judge_input(step.step_id, order=JudgeOrder.b_a, paired_with=first.judge_result_id),
        )
    assert second.swapped_agrees is True
    assert (await judge_rows(session_factory, step.step_id))[0].pairwise == {"swapped_agrees": True}


async def test_the_tiebreak_is_retried_on_overload_and_then_succeeds(
    temporal_env: WorkflowEnvironment,
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_anthropic(
        anthropic_error(529, "overloaded_error"), anthropic_reply(PASS_WITH_GOLD)
    )
    async with running(temporal_env, activities):
        output = await execute(
            temporal_env,
            JUDGE_TIEBREAK_ACTIVITY,
            judge_input(step.step_id, spec=tiebreak_spec()),
        )
    assert output.verdict.status is VerdictStatus.pass_
    assert len(fake_provider.anthropic_requests) == 2


async def test_a_missing_tiebreak_key_ends_the_activity_without_a_retry(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    fake_provider: FakeProvider,
) -> None:
    keyless = default_judge_activities(
        worker_settings, session_factory, FakeProviders(fake_provider, anthropic_key=False)
    )
    step = await seed_step(session_factory, gold_points=[gold_point()])
    async with running(temporal_env, keyless):
        with pytest.raises(WorkflowFailureError) as caught:
            await execute(
                temporal_env,
                JUDGE_TIEBREAK_ACTIVITY,
                judge_input(step.step_id, spec=tiebreak_spec()),
            )
    assert failure_cause(caught.value).type == GradingErrorType.tiebreak_unavailable
    assert fake_provider.request_count == 0
