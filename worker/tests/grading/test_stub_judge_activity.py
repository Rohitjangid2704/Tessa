import json
from decimal import Decimal

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import JudgeFamily, JudgeOrder, ModelRole, VerdictStatus
from tessa_api.schemas.grading import JudgeStepInput, JudgeStepOutput
from tessa_worker.activities.judge import JudgeActivities, default_judge_activities
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.settings import WorkerSettings
from tessa_worker.testing.stub_models import (
    STUB_MODEL_ID,
    STUB_REASON_CODE,
    StubModelRegistry,
    default_stub_registry,
)
from tests.fakes.openai import FakeProvider, valid_answer
from tests.grading.support import (
    ANSWER,
    GOLD_KEY,
    GOLD_RENDERED,
    FakeProviders,
    evidence_block,
    gold_point,
    judge_input,
    judge_rows,
    model_spec,
    seed_step,
    tiebreak_spec,
)

pytestmark = pytest.mark.integration

STATED_ANSWER = f"Yes, {GOLD_RENDERED} right now."


def stub_activities(
    settings: WorkerSettings,
    session_factory: SessionFactory,
    provider: FakeProvider,
    stubs: StubModelRegistry | None = None,
) -> JudgeActivities:
    return default_judge_activities(
        settings, session_factory, FakeProviders(provider, False, False), stubs
    )


async def run_judge(activities: JudgeActivities, request: JudgeStepInput) -> JudgeStepOutput:
    return await ActivityEnvironment().run(activities.judge_step, request)


async def test_a_stub_judge_makes_no_provider_call_and_costs_nothing(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(session_factory, answer=STATED_ANSWER, gold_points=[gold_point()])
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    evidence = evidence_block(answer=STATED_ANSWER)
    output = await run_judge(activities, judge_input(step.step_id, evidence))
    assert output.verdict.status is VerdictStatus.pass_
    assert (output.cost_usd, output.input_tokens, output.output_tokens) == (0.0, 0, 0)
    assert fake_provider.request_count == 0


async def test_a_stub_result_is_visible_as_a_stub_everywhere(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(session_factory, answer=STATED_ANSWER, gold_points=[gold_point()])
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    spec = model_spec(model="stub")
    evidence = evidence_block(answer=STATED_ANSWER)
    output = await run_judge(activities, judge_input(step.step_id, evidence, spec))
    assert output.verdict.reason_code == STUB_REASON_CODE
    row = (await judge_rows(session_factory, step.step_id))[0]
    assert row.model == STUB_MODEL_ID
    assert row.cost_usd == Decimal("0")
    assert row.verdict["reason_code"] == STUB_REASON_CODE
    assert row.evidence["billing"]["calls"][0]["basis"] == "stub"
    assert row.evidence["billing"]["calls"][0]["model"] == STUB_MODEL_ID


async def test_a_real_model_id_in_the_spec_is_still_recorded_as_stub(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    await run_judge(activities, judge_input(step.step_id))
    row = (await judge_rows(session_factory, step.step_id))[0]
    assert row.model == STUB_MODEL_ID


@pytest.mark.parametrize(
    ("answer", "status"),
    [
        (STATED_ANSWER, VerdictStatus.pass_),
        ("Nothing is open.", VerdictStatus.fail),
        ("", VerdictStatus.uncertain),
    ],
)
async def test_the_stub_verdict_follows_the_evidence_and_keeps_the_stub_reason(
    stub_settings: WorkerSettings,
    session_factory: SessionFactory,
    fake_provider: FakeProvider,
    answer: str,
    status: VerdictStatus,
) -> None:
    step = await seed_step(session_factory, answer=answer, gold_points=[gold_point()])
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    output = await run_judge(activities, judge_input(step.step_id, evidence_block(answer=answer)))
    assert output.verdict.status is status
    assert output.verdict.reason_code == STUB_REASON_CODE


async def test_stubs_are_deterministic_across_steps(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    outputs = []
    for _ in range(2):
        step = await seed_step(session_factory, answer=ANSWER, gold_points=[gold_point()])
        outputs.append(await run_judge(activities, judge_input(step.step_id)))
    first, second = outputs
    assert first.verdict == second.verdict
    assert first.rationale == second.rationale
    assert first.evidence == second.evidence


async def test_a_stub_pair_agrees_and_completes_the_pairwise_result(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(session_factory, answer=STATED_ANSWER, gold_points=[gold_point()])
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    evidence = evidence_block(answer=STATED_ANSWER)
    first = await run_judge(activities, judge_input(step.step_id, evidence))
    second = await run_judge(
        activities,
        judge_input(
            step.step_id, evidence, order=JudgeOrder.b_a, paired_with=first.judge_result_id
        ),
    )
    assert second.swapped_agrees is True
    assert second.verdict.reason_code == STUB_REASON_CODE
    assert (await judge_rows(session_factory, step.step_id))[0].pairwise == {"swapped_agrees": True}


async def test_a_scripted_stub_can_force_a_position_disagreement(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    answers = iter(
        [
            valid_answer("pass", 0.9, gold_points_used=(GOLD_KEY,)),
            valid_answer("fail", 0.9),
        ]
    )
    stubs = StubModelRegistry()
    stubs.register(ModelRole.judge, lambda call: json.dumps(next(answers)))
    activities = stub_activities(stub_settings, session_factory, fake_provider, stubs)
    first = await run_judge(activities, judge_input(step.step_id))
    second = await run_judge(
        activities,
        judge_input(step.step_id, order=JudgeOrder.b_a, paired_with=first.judge_result_id),
    )
    assert second.swapped_agrees is False
    assert second.verdict.status is VerdictStatus.uncertain
    assert second.verdict.reason_code == STUB_REASON_CODE


@pytest.mark.parametrize(
    "canned", ["not json", '{"verdict": "pass"}', json.dumps({**valid_answer(), "x": 1})]
)
async def test_validation_is_unchanged_a_bad_stub_output_is_uncertain_never_a_pass(
    stub_settings: WorkerSettings,
    session_factory: SessionFactory,
    fake_provider: FakeProvider,
    canned: str,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    stubs = default_stub_registry()
    stubs.replace(ModelRole.judge, lambda call: canned)
    activities = stub_activities(stub_settings, session_factory, fake_provider, stubs)
    output = await run_judge(activities, judge_input(step.step_id))
    assert output.verdict.status is VerdictStatus.uncertain
    assert output.verdict.reason_code == STUB_REASON_CODE
    assert "judge_output_invalid" in (output.verdict.reason or "")


async def test_the_ledger_pre_check_still_applies_to_stub_calls(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(
        session_factory, gold_points=[gold_point()], budget_max_usd=0.01, spent_usd=0.0
    )
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    with pytest.raises(ApplicationError) as caught:
        await run_judge(activities, judge_input(step.step_id))
    assert caught.value.type == GradingErrorType.budget_exceeded
    assert await judge_rows(session_factory, step.step_id) == []


async def test_the_stub_tiebreak_needs_no_anthropic_key(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(session_factory, answer=STATED_ANSWER, gold_points=[gold_point()])
    activities = stub_activities(stub_settings, session_factory, fake_provider)
    evidence = evidence_block(answer=STATED_ANSWER)
    output = await ActivityEnvironment().run(
        activities.judge_tiebreak, judge_input(step.step_id, evidence, tiebreak_spec())
    )
    assert output.verdict.status is VerdictStatus.pass_
    assert output.verdict.reason_code == STUB_REASON_CODE
    row = (await judge_rows(session_factory, step.step_id))[0]
    assert (row.family, row.model) == (JudgeFamily.anthropic, STUB_MODEL_ID)
    assert fake_provider.request_count == 0


async def test_an_unregistered_role_stub_is_a_loud_failure(
    stub_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    activities = stub_activities(stub_settings, session_factory, fake_provider, StubModelRegistry())
    with pytest.raises(ApplicationError) as caught:
        await run_judge(activities, judge_input(step.step_id))
    assert caught.value.type == GradingErrorType.stub_not_registered
    assert caught.value.non_retryable is True
