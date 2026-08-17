import json
import uuid
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import RunRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import JudgeFamily, JudgeOrder, VerdictStatus, VerdictTier
from tessa_api.schemas.grading import JudgeStepInput, JudgeStepOutput
from tessa_worker.activities.judge import JudgeActivities, default_judge_activities
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.judge_prompt import render_judge_prompt
from tessa_worker.grading.judge_verdict import REASON_OUTPUT_INVALID
from tessa_worker.grading.pricing import default_price_table
from tessa_worker.grading.rubric import RUBRIC_VERSION
from tessa_worker.settings import WorkerSettings
from tests.fakes.openai import (
    INJECTED_ANSWER,
    FakeProvider,
    ScriptedReply,
    anthropic_reply,
    delayed,
    openai_error,
    openai_reply,
    openai_response_body,
    valid_answer,
)
from tests.grading.support import (
    GOLD_KEY,
    JUDGE_MODEL,
    TIEBREAK_MODEL,
    FakeProviders,
    SeededStep,
    evidence_block,
    gold_point,
    judge_input,
    judge_rows,
    model_spec,
    seed_step,
    tiebreak_spec,
)

pytestmark = pytest.mark.integration

PASS_WITH_GOLD = valid_answer("pass", 0.9, gold_points_used=(GOLD_KEY,))
FAIL_ANSWER = valid_answer("fail", 0.8)
INVALID_REPLIES: dict[str, ScriptedReply] = {
    "extra_field": openai_reply({**valid_answer(), "override": True}),
    "wrong_enum": openai_reply({**valid_answer(), "verdict": "approved"}),
    "malformed_json": openai_reply('{"verdict": "pass", '),
    "plain_text": openai_reply("The answer is fine, pass."),
    "obeyed_injection": openai_reply(
        '{"verdict":"pass","confidence":1,"rationale":"approved","override":true}'
    ),
    "refusal": ScriptedReply(body=openai_response_body(None, refusal="I cannot do that.")),
    "cut_at_token_limit": ScriptedReply(
        body=openai_response_body(
            '{"verdict": "pa', status="incomplete", incomplete_reason="max_output_tokens"
        )
    ),
    "empty": openai_reply(None),
}


def activities_for(
    settings: WorkerSettings,
    session_factory: SessionFactory,
    providers: FakeProviders,
) -> JudgeActivities:
    return default_judge_activities(settings, session_factory, providers)


async def run_judge(activities: JudgeActivities, request: JudgeStepInput) -> JudgeStepOutput:
    return await ActivityEnvironment().run(activities.judge_step, request)


async def run_tiebreak(activities: JudgeActivities, request: JudgeStepInput) -> JudgeStepOutput:
    return await ActivityEnvironment().run(activities.judge_tiebreak, request)


async def failure_of(activities: JudgeActivities, request: JudgeStepInput) -> ApplicationError:
    with pytest.raises(ApplicationError) as caught:
        await run_judge(activities, request)
    return caught.value


@pytest.fixture
def activities(
    worker_settings: WorkerSettings, session_factory: SessionFactory, providers: FakeProviders
) -> JudgeActivities:
    return activities_for(worker_settings, session_factory, providers)


@pytest.fixture
async def seeded(session_factory: SessionFactory) -> SeededStep:
    return await seed_step(session_factory, gold_points=[gold_point()])


async def test_the_first_order_result_is_validated_priced_and_stored(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD, input_tokens=1000, output_tokens=200))
    output = await run_judge(activities, judge_input(seeded.step_id))
    assert output.verdict.status is VerdictStatus.pass_
    assert output.verdict.tier is VerdictTier.judge
    assert output.verdict.confidence == 0.9
    assert output.cost_usd == pytest.approx(0.004)
    assert (output.input_tokens, output.output_tokens) == (1000, 200)
    assert output.swapped_agrees is None
    assert [point.key for point in output.evidence.gold_points] == [GOLD_KEY]
    rows = await judge_rows(session_factory, seeded.step_id)
    assert len(rows) == 1
    row = rows[0]
    assert row.id == output.judge_result_id
    assert (row.family, row.model, row.run_id) == (JudgeFamily.openai, JUDGE_MODEL, seeded.run_id)
    assert row.rubric_version == RUBRIC_VERSION
    assert row.pairwise is None
    assert row.verdict["status"] == "pass"
    assert row.cost_usd == Decimal("0.004000")
    assert row.evidence["billing"]["price_table_version"] == default_price_table().version
    assert row.evidence["billing"]["calls"][0]["basis"] == "metered"


async def test_the_request_sent_to_openai_carries_the_evidence_and_the_spec(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD))
    request = judge_input(seeded.step_id, spec=model_spec(max_output_tokens=500))
    await run_judge(activities, request)
    body = fake_provider.openai_requests[0].body
    assert body is not None
    prompt = render_judge_prompt(request.evidence, JudgeOrder.a_b)
    assert body["input"] == prompt.input_text
    assert body["instructions"] == prompt.instructions
    assert body["max_output_tokens"] == 500


@pytest.mark.parametrize(
    ("budget", "spent", "refused"),
    [
        (5.0, 4.96, True),
        (5.0, 5.0, True),
        (5.0, 7.0, True),
        (0.04, 0.0, True),
        (5.0, 4.95, False),
        (5.0, 0.0, False),
    ],
)
async def test_the_ledger_pre_check_compares_the_call_maximum_with_what_is_left(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    budget: float,
    spent: float,
    refused: bool,
) -> None:
    step = await seed_step(
        session_factory, gold_points=[gold_point()], budget_max_usd=budget, spent_usd=spent
    )
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD))
    request = judge_input(step.step_id, spec=model_spec(max_usd=0.05))
    if not refused:
        output = await run_judge(activities, request)
        assert output.verdict.status is VerdictStatus.pass_
        return
    error = await failure_of(activities, request)
    assert error.type == GradingErrorType.budget_exceeded
    assert error.non_retryable is True
    assert fake_provider.request_count == 0
    assert await judge_rows(session_factory, step.step_id) == []


async def test_a_refused_budget_stops_the_swapped_call_before_it_is_made(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD))
    first = await run_judge(activities, judge_input(seeded.step_id))
    async with session_factory() as session:
        run = await session.get(RunRow, seeded.run_id)
        assert run is not None
        run.spent_usd = Decimal("4.99")
        await session.commit()
    swapped = judge_input(seeded.step_id, order=JudgeOrder.b_a, paired_with=first.judge_result_id)
    error = await failure_of(activities, swapped)
    assert error.type == GradingErrorType.budget_exceeded
    assert fake_provider.request_count == 1


async def test_two_orders_that_agree_complete_the_pairwise_result(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(
        openai_reply(valid_answer("pass", 0.9, gold_points_used=(GOLD_KEY,))),
        openai_reply(valid_answer("pass", 0.7, gold_points_used=(GOLD_KEY,))),
    )
    evidence = evidence_block()
    first = await run_judge(activities, judge_input(seeded.step_id, evidence))
    second = await run_judge(
        activities,
        judge_input(
            seeded.step_id, evidence, order=JudgeOrder.b_a, paired_with=first.judge_result_id
        ),
    )
    assert second.judge_result_id == first.judge_result_id
    assert second.swapped_agrees is True
    assert second.verdict.status is VerdictStatus.pass_
    assert second.verdict.confidence == 0.7
    rows = await judge_rows(session_factory, seeded.step_id)
    assert len(rows) == 1
    assert rows[0].pairwise == {"swapped_agrees": True}
    assert rows[0].verdict["confidence"] == 0.7
    assert rows[0].cost_usd == Decimal(str(first.cost_usd)) + Decimal(str(second.cost_usd))
    calls = rows[0].evidence["billing"]["calls"]
    assert [call["order"] for call in calls] == ["a_b", "b_a"]
    bodies = [sent.body for sent in fake_provider.openai_requests]
    assert bodies[0] is not None
    assert bodies[1] is not None
    assert bodies[0]["input"].startswith("<<<candidate ")
    assert bodies[1]["input"].startswith("<<<reference ")


async def test_two_orders_that_disagree_end_uncertain_and_say_so(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD), openai_reply(FAIL_ANSWER))
    first = await run_judge(activities, judge_input(seeded.step_id))
    second = await run_judge(
        activities,
        judge_input(seeded.step_id, order=JudgeOrder.b_a, paired_with=first.judge_result_id),
    )
    assert first.verdict.status is VerdictStatus.pass_
    assert second.swapped_agrees is False
    assert second.verdict.status is VerdictStatus.uncertain
    assert second.verdict.reason_code == "judge_order_disagreement"
    row = (await judge_rows(session_factory, seeded.step_id))[0]
    assert row.pairwise == {"swapped_agrees": False}
    assert row.verdict["status"] == "uncertain"
    assert row.evidence["billing"]["calls"][0]["verdict"]["status"] == "pass"


async def test_without_a_reference_one_pass_is_enough(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    step = await seed_step(session_factory)
    fake_provider.enqueue_openai(openai_reply(valid_answer("uncertain", 0.4)))
    evidence = evidence_block(gold_points=[])
    output = await run_judge(activities, judge_input(step.step_id, evidence))
    assert output.swapped_agrees is None
    assert fake_provider.request_count == 1
    row = (await judge_rows(session_factory, step.step_id))[0]
    assert row.pairwise is None


async def test_a_swapped_call_needs_the_first_order_result(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    request = judge_input(seeded.step_id, order=JudgeOrder.b_a, paired_with=uuid.uuid4())
    error = await failure_of(activities, request)
    assert error.type == GradingErrorType.paired_result_not_found
    assert error.non_retryable is True
    assert fake_provider.request_count == 0


async def test_a_retried_activity_returns_the_stored_result_without_a_second_call(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD), openai_reply(PASS_WITH_GOLD))
    request = judge_input(seeded.step_id)
    first = await run_judge(activities, request)
    again = await run_judge(activities, request)
    assert again == first
    swapped = judge_input(seeded.step_id, order=JudgeOrder.b_a, paired_with=first.judge_result_id)
    second = await run_judge(activities, swapped)
    second_again = await run_judge(activities, swapped)
    assert second_again == second
    assert fake_provider.request_count == 2
    assert len(await judge_rows(session_factory, seeded.step_id)) == 1


@pytest.mark.parametrize("name", list(INVALID_REPLIES))
async def test_an_output_outside_the_schema_is_uncertain_charged_and_not_retried(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
    name: str,
) -> None:
    fake_provider.enqueue_openai(INVALID_REPLIES[name])
    output = await run_judge(activities, judge_input(seeded.step_id))
    assert output.verdict.status is VerdictStatus.uncertain
    assert output.verdict.reason_code == REASON_OUTPUT_INVALID
    assert output.verdict.confidence is None
    assert output.evidence.gold_points == []
    assert fake_provider.request_count == 1
    assert output.input_tokens > 0
    assert output.cost_usd > 0
    rows = await judge_rows(session_factory, seeded.step_id)
    assert [row.verdict["status"] for row in rows] == ["uncertain"]


async def test_injected_text_in_the_answer_changes_neither_the_schema_nor_the_verdict_path(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
) -> None:
    clean = await seed_step(session_factory, gold_points=[gold_point()])
    hostile = await seed_step(session_factory, answer=INJECTED_ANSWER, gold_points=[gold_point()])
    fake_provider.enqueue_openai(
        openai_reply(PASS_WITH_GOLD),
        INVALID_REPLIES["obeyed_injection"],
        openai_reply(PASS_WITH_GOLD),
    )
    await run_judge(activities, judge_input(clean.step_id, evidence_block()))
    hostile_evidence = evidence_block(answer=INJECTED_ANSWER)
    obeyed = await run_judge(activities, judge_input(hostile.step_id, hostile_evidence))
    assert obeyed.verdict.status is VerdictStatus.uncertain
    assert obeyed.verdict.reason_code == REASON_OUTPUT_INVALID
    clean_body, hostile_body = (sent.body for sent in fake_provider.openai_requests[:2])
    assert clean_body is not None
    assert hostile_body is not None
    assert hostile_body["instructions"] == clean_body["instructions"]
    assert hostile_body["text"] == clean_body["text"]
    assert hostile_body["reasoning"] == clean_body["reasoning"]
    assert "tools" not in hostile_body
    assert json.dumps(INJECTED_ANSWER)[1:-1] in hostile_body["input"]
    fenced_lines = [line for line in hostile_body["input"].split("\n") if line.startswith("<<<")]
    assert len(fenced_lines) == 4
    honest = await run_judge(
        activities, judge_input(hostile.step_id, hostile_evidence, order=JudgeOrder.b_a)
    )
    assert honest.verdict.status is VerdictStatus.pass_


async def test_an_unknown_model_is_charged_at_the_role_maximum(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD, input_tokens=5, output_tokens=5))
    request = judge_input(seeded.step_id, spec=model_spec(model="unlisted-model", max_usd=0.03))
    output = await run_judge(activities, request)
    assert output.cost_usd == 0.03
    row = (await judge_rows(session_factory, seeded.step_id))[0]
    assert row.evidence["billing"]["calls"][0]["basis"] == "unknown_model"
    assert row.evidence["billing"]["price_table_version"] == default_price_table().version


async def test_missing_token_usage_is_charged_at_the_role_maximum(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    fake_provider.enqueue_openai(
        ScriptedReply(body=openai_response_body(json.dumps(PASS_WITH_GOLD), with_usage=False))
    )
    output = await run_judge(activities, judge_input(seeded.step_id, spec=model_spec(max_usd=0.04)))
    assert output.cost_usd == 0.04
    assert (output.input_tokens, output.output_tokens) == (0, 0)


async def test_cached_input_tokens_are_priced_at_the_cached_rate(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    fake_provider.enqueue_openai(
        openai_reply(PASS_WITH_GOLD, input_tokens=10_000, output_tokens=0, cached_tokens=10_000)
    )
    output = await run_judge(activities, judge_input(seeded.step_id))
    assert output.cost_usd == pytest.approx(0.001)


async def test_a_judge_step_refuses_a_tiebreak_spec_and_the_reverse(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    error = await failure_of(activities, judge_input(seeded.step_id, spec=tiebreak_spec()))
    assert error.type == GradingErrorType.role_mismatch
    with pytest.raises(ApplicationError) as caught:
        await run_tiebreak(activities, judge_input(seeded.step_id, spec=model_spec()))
    assert caught.value.type == GradingErrorType.role_mismatch
    assert fake_provider.request_count == 0


async def test_a_run_planned_with_stub_models_is_refused_by_a_real_worker(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    error = await failure_of(activities, judge_input(seeded.step_id, spec=model_spec(model="stub")))
    assert error.type == GradingErrorType.stub_model_mismatch
    assert error.non_retryable is True
    assert fake_provider.request_count == 0


async def test_a_step_that_does_not_exist_is_a_permanent_error(
    activities: JudgeActivities, fake_provider: FakeProvider, session_factory: SessionFactory
) -> None:
    error = await failure_of(activities, judge_input(uuid.uuid4()))
    assert error.type == GradingErrorType.step_not_found
    assert error.non_retryable is True
    assert fake_provider.request_count == 0


async def test_a_prompt_over_the_input_budget_is_refused_before_any_call(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    error = await failure_of(
        activities, judge_input(seeded.step_id, spec=model_spec(max_input_tokens=50))
    )
    assert error.type == GradingErrorType.input_too_large
    assert error.non_retryable is True
    assert fake_provider.request_count == 0


async def test_a_missing_openai_key_is_a_permanent_error(
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    fake_provider: FakeProvider,
    seeded: SeededStep,
) -> None:
    keyless = activities_for(
        worker_settings, session_factory, FakeProviders(fake_provider, openai_key=False)
    )
    error = await failure_of(keyless, judge_input(seeded.step_id))
    assert error.type == GradingErrorType.provider_key_missing
    assert error.non_retryable is True


@pytest.mark.parametrize(
    ("reply", "retryable", "kind"),
    [
        (openai_error(429, "rate_limit_exceeded"), True, GradingErrorType.provider_unavailable),
        (openai_error(500), True, GradingErrorType.provider_unavailable),
        (openai_error(503), True, GradingErrorType.provider_unavailable),
        (openai_error(401, "invalid_api_key"), False, GradingErrorType.provider_rejected),
        (openai_error(400), False, GradingErrorType.provider_rejected),
        (openai_error(429, "insufficient_quota"), False, GradingErrorType.provider_rejected),
    ],
)
async def test_provider_failures_raise_errors_temporal_can_classify(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
    reply: ScriptedReply,
    retryable: bool,
    kind: GradingErrorType,
) -> None:
    fake_provider.enqueue_openai(reply)
    error = await failure_of(activities, judge_input(seeded.step_id))
    assert error.type == kind
    assert error.non_retryable is not retryable
    assert await judge_rows(session_factory, seeded.step_id) == []
    assert fake_provider.request_count == 1


async def test_a_call_that_outlives_its_timeout_is_a_retryable_error(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(delayed(openai_reply(PASS_WITH_GOLD), 5.0))
    request = judge_input(seeded.step_id, spec=model_spec(timeout_seconds=6))
    error = await failure_of(activities, request)
    assert error.type == GradingErrorType.provider_unavailable
    assert error.non_retryable is False
    assert await judge_rows(session_factory, seeded.step_id) == []


async def test_the_tiebreak_calls_anthropic_and_writes_its_own_row(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_anthropic(
        anthropic_reply(PASS_WITH_GOLD, input_tokens=2000, output_tokens=100)
    )
    output = await run_tiebreak(activities, judge_input(seeded.step_id, spec=tiebreak_spec()))
    assert output.verdict.status is VerdictStatus.pass_
    assert output.verdict.tier is VerdictTier.judge
    assert output.cost_usd == pytest.approx(0.005)
    assert output.swapped_agrees is None
    assert fake_provider.openai_requests == []
    row = (await judge_rows(session_factory, seeded.step_id))[0]
    assert (row.family, row.model, row.pairwise) == (JudgeFamily.anthropic, TIEBREAK_MODEL, None)


async def test_the_tiebreak_uses_the_same_schema_and_evidence_as_the_judge(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD))
    fake_provider.enqueue_anthropic(anthropic_reply(PASS_WITH_GOLD))
    request = judge_input(seeded.step_id)
    await run_judge(activities, request)
    await run_tiebreak(activities, request.model_copy(update={"spec": tiebreak_spec()}))
    openai_body = fake_provider.openai_requests[0].body
    anthropic_body = fake_provider.anthropic_requests[0].body
    assert openai_body is not None
    assert anthropic_body is not None
    assert anthropic_body["messages"][0]["content"] == openai_body["input"]
    assert anthropic_body["system"] == openai_body["instructions"]
    assert (
        anthropic_body["output_config"]["format"]["schema"]
        == openai_body["text"]["format"]["schema"]
    )


async def test_without_an_anthropic_key_the_tiebreak_is_unavailable_and_nothing_is_written(
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    fake_provider: FakeProvider,
    seeded: SeededStep,
) -> None:
    keyless = activities_for(
        worker_settings, session_factory, FakeProviders(fake_provider, anthropic_key=False)
    )
    with pytest.raises(ApplicationError) as caught:
        await run_tiebreak(keyless, judge_input(seeded.step_id, spec=tiebreak_spec()))
    assert caught.value.type == GradingErrorType.tiebreak_unavailable
    assert caught.value.non_retryable is True
    assert fake_provider.request_count == 0
    assert await judge_rows(session_factory, seeded.step_id) == []


async def test_a_tiebreak_output_outside_the_schema_stays_uncertain(
    activities: JudgeActivities, fake_provider: FakeProvider, seeded: SeededStep
) -> None:
    fake_provider.enqueue_anthropic(anthropic_reply({**valid_answer(), "extra": 1}))
    output = await run_tiebreak(activities, judge_input(seeded.step_id, spec=tiebreak_spec()))
    assert output.verdict.status is VerdictStatus.uncertain
    assert output.verdict.reason_code == REASON_OUTPUT_INVALID


async def test_the_judge_never_writes_to_the_step_it_judges(
    activities: JudgeActivities,
    fake_provider: FakeProvider,
    session_factory: SessionFactory,
    seeded: SeededStep,
) -> None:
    fake_provider.enqueue_openai(openai_reply(PASS_WITH_GOLD))
    async with session_factory() as session:
        before = (await session.scalars(select(StepRow).where(StepRow.id == seeded.step_id))).one()
        snapshot: dict[str, Any] = {"verdict": before.verdict, "answer": before.answer}
    await run_judge(activities, judge_input(seeded.step_id))
    async with session_factory() as session:
        after = (await session.scalars(select(StepRow).where(StepRow.id == seeded.step_id))).one()
        assert {"verdict": after.verdict, "answer": after.answer} == snapshot
