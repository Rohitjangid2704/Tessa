import uuid
from typing import Any

import pytest
from sqlalchemy import update
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.grading import EvidenceBlock
from tessa_worker.activities.judge import JudgeActivities, default_judge_activities
from tessa_worker.activities.judge_models import BuildStepEvidenceInput
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.settings import WorkerSettings
from tests.fakes.openai import FakeProvider
from tests.grading.support import (
    ANSWER,
    ASK,
    CODE_INVARIANT_ID,
    GOLD_KEY,
    GOLD_RENDERED,
    PROBE_INVARIANT_ID,
    SECRET_ASSIGNMENT,
    FakeProviders,
    gold_point,
    manifest_with_feature_invariants,
    seed_step,
    stored_evidence_of,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def activities(
    worker_settings: WorkerSettings, session_factory: SessionFactory, fake_provider: FakeProvider
) -> JudgeActivities:
    return default_judge_activities(worker_settings, session_factory, FakeProviders(fake_provider))


async def build(activities: JudgeActivities, step_id: uuid.UUID) -> EvidenceBlock:
    return await ActivityEnvironment().run(
        activities.build_step_evidence, BuildStepEvidenceInput(step_id=step_id)
    )


async def test_the_block_is_built_from_the_stored_step_and_stored_on_it(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    block = await build(activities, step.step_id)
    assert block.ask == ASK
    assert block.answer == ANSWER
    assert [point.key for point in block.gold_points] == [GOLD_KEY]
    assert block.gold_points[0].rendered == GOLD_RENDERED
    stored = await stored_evidence_of(session_factory, step.step_id)
    assert EvidenceBlock.model_validate(stored) == block


async def test_the_stored_block_has_exactly_the_allow_listed_keys(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    await build(activities, step.step_id)
    stored = await stored_evidence_of(session_factory, step.step_id)
    assert set(stored) == set(EvidenceBlock.model_fields)
    assert set(stored["gold_points"][0]) == {"key", "value", "rendered"}


async def test_only_the_invariants_a_judge_can_assess_are_included(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    manifest = manifest_with_feature_invariants(CODE_INVARIANT_ID, PROBE_INVARIANT_ID)
    step = await seed_step(session_factory, manifest=manifest)
    block = await build(activities, step.step_id)
    assert [invariant.id for invariant in block.invariants] == [PROBE_INVARIANT_ID]
    assert (
        block.invariants[0].rule
        == "The assistant never says a write happened before the confirmation"
    )


async def test_no_bundle_text_beyond_the_invariant_rules_reaches_the_block(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    manifest: dict[str, Any] = manifest_with_feature_invariants(PROBE_INVARIANT_ID)
    manifest["app"]["summary"] = "BUNDLE-ONLY-APP-SUMMARY"
    manifest["features"][0]["description"] = "BUNDLE-ONLY-FEATURE-DESCRIPTION"
    manifest["seeds"]["description"] = "BUNDLE-ONLY-SEED-DESCRIPTION"
    step = await seed_step(session_factory, manifest=manifest)
    block = await build(activities, step.step_id)
    dumped = block.model_dump_json()
    assert "BUNDLE-ONLY" not in dumped
    stored = str(await stored_evidence_of(session_factory, step.step_id))
    assert "BUNDLE-ONLY" not in stored


async def test_a_step_with_no_matching_feature_has_no_invariants(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    manifest = manifest_with_feature_invariants(PROBE_INVARIANT_ID)
    for feature in manifest["features"]:
        feature["id"] = f"renamed.{feature['id']}"
    step = await seed_step(session_factory, manifest=manifest)
    assert (await build(activities, step.step_id)).invariants == []


async def test_a_step_without_a_manifest_still_builds(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    step = await seed_step(session_factory)
    block = await build(activities, step.step_id)
    assert block.invariants == []
    assert block.gold_points == []


async def test_secrets_in_the_stored_step_are_redacted_in_the_block_and_in_the_row(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    step = await seed_step(session_factory, answer=f"Here it is: {SECRET_ASSIGNMENT} done")
    block = await build(activities, step.step_id)
    assert "Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A" not in block.model_dump_json()
    stored = await stored_evidence_of(session_factory, step.step_id)
    assert "Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A" not in str(stored)


async def test_building_twice_gives_the_same_block(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    assert await build(activities, step.step_id) == await build(activities, step.step_id)


async def test_a_missing_step_is_a_permanent_error(activities: JudgeActivities) -> None:
    with pytest.raises(ApplicationError) as caught:
        await build(activities, uuid.uuid4())
    assert caught.value.type == GradingErrorType.step_not_found
    assert caught.value.non_retryable is True


async def test_unreadable_gold_points_are_a_permanent_error(
    activities: JudgeActivities, session_factory: SessionFactory
) -> None:
    step = await seed_step(session_factory)
    async with session_factory() as session:
        await session.execute(
            update(StepRow).where(StepRow.id == step.step_id).values(gold_points=[{"key": 1}])
        )
        await session.commit()
    with pytest.raises(ApplicationError) as caught:
        await build(activities, step.step_id)
    assert caught.value.type == GradingErrorType.evidence_invalid
    assert caught.value.non_retryable is True
