from typing import Any
from uuid import UUID

import pytest
from pydantic import BaseModel, ValidationError
from temporalio.contrib.pydantic import pydantic_data_converter

from tessa_api.schemas import temporal
from tessa_api.schemas.enums import JudgeOrder, SeedAction
from tessa_api.schemas.grading import (
    EvidenceBlock,
    GradePolicy,
    JudgeStepInput,
    JudgeStepOutput,
    ModelCallSpec,
    ProbeBatchResult,
)
from tessa_api.schemas.runs import ClockSnapshot
from tessa_api.schemas.temporal import (
    CheckDbExpectationInput,
    CheckDbExpectationResult,
    ExecuteOracleQueryInput,
    ExecuteOracleQueryResult,
    ExecuteResetScriptInput,
    ExecuteResetScriptResult,
    GradeStepInput,
    GradeStepResult,
    JudgeTiebreakInput,
    JudgeTiebreakOutput,
    LoadSeedMaterialInput,
    LoadSeedMaterialResult,
    RenderExpectedSentenceInput,
    RenderExpectedSentenceResult,
    ResolveClockInput,
    ResolveClockResult,
    ResolveGoldPointsInput,
    ResolveGoldPointsResult,
    RunHashCommandInput,
    RunHashCommandResult,
    RunLayaProbesInput,
    RunLayaProbesResult,
    RunOracleInput,
    RunOracleResult,
    SeedAssertionResult,
    SeedTargetInput,
    SeedTargetProgress,
    SeedTargetResult,
    StoreWeakLabelInput,
    StoreWeakLabelResult,
    grade_step_workflow_id,
    run_oracle_workflow_id,
    seed_target_workflow_id,
)
from tests.test_stage_three_four_models import EXAMPLES

RUN_ID = UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11")
TARGET_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000006")
SEED_ID = UUID("0198f6f2-7b00-7a00-9d00-0000000000a1")
STEP_ID = UUID("0198f6f2-8a11-7c33-8e02-19d0a5a7c9b4")
RUN_SCENARIO_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000001")
ORACLE_RESULT_ID = UUID("0198f6f2-7b00-7a00-9d00-0000000000b2")
JUDGE_RESULT_ID = UUID("0198f6f2-7b00-7a00-9d00-0000000000d1")
MAX_PAYLOAD_BYTES = 256 * 1024

VERDICT: dict[str, Any] = EXAMPLES["JudgeResult"]["verdict"]
POLICY = GradePolicy(probe_confidence=0.75, judge_escalate_below=0.6, tiebreak_enabled=True)
SPEC = ModelCallSpec.model_validate(
    {
        "role": "judge",
        "model": "gpt-6.1-sol",
        "effort": "low",
        "max_usd": 0.05,
        "max_input_tokens": 6000,
        "max_output_tokens": 800,
        "start_to_close_timeout_seconds": 60,
        "max_attempts": 2,
    }
)
JUDGE_INPUT = JudgeStepInput(
    step_id=STEP_ID,
    evidence=EvidenceBlock.model_validate(EXAMPLES["EvidenceBlock"]),
    order=JudgeOrder.a_b,
    spec=SPEC,
)

SAMPLES: list[BaseModel] = [
    SeedTargetInput(run_id=RUN_ID, target_id=TARGET_ID, seed_id=SEED_ID, action=SeedAction.reset),
    SeedTargetResult(matched=True, observed_hash="sha256:abcd1234", expected_hash=None),
    SeedTargetResult(matched=False, observed_hash="sha256:a", expected_hash="sha256:b"),
    SeedTargetProgress.model_validate({"phase": "hash", "status": "started"}),
    SeedAssertionResult(
        outcome="mismatch",
        seed_hash=None,
        observed_hash="sha256:a",
        expected_hash="sha256:b",
        reason="hash differs",
    ),
    SeedAssertionResult(
        outcome="unverified",
        seed_hash=None,
        observed_hash=None,
        expected_hash=None,
        reason="seed_unverified",
    ),
    RunOracleInput(oracle_result_id=ORACLE_RESULT_ID),
    RunOracleResult.model_validate({"status": "ok"}),
    LoadSeedMaterialInput(seed_id=SEED_ID),
    LoadSeedMaterialResult(
        reset_script_ref="seeds/reset.sql",
        hash_command_ref=str(SEED_ID),
        script_timeout_seconds=300,
    ),
    LoadSeedMaterialResult(
        reset_script_ref=None, hash_command_ref=None, script_timeout_seconds=300
    ),
    ExecuteResetScriptInput(run_id=RUN_ID, seed_id=SEED_ID),
    ExecuteResetScriptResult(exit_code=0, output_excerpt="1 row"),
    RunHashCommandInput(seed_id=SEED_ID),
    RunHashCommandResult(observed_hash="sha256:abcd1234"),
    ExecuteOracleQueryInput(oracle_result_id=ORACLE_RESULT_ID),
    ExecuteOracleQueryResult.model_validate(
        {"status": "ok", "row_count": 200, "rows_truncated": True, "duration_ms": 41, "error": None}
    ),
    ExecuteOracleQueryResult.model_validate(
        {
            "status": "error",
            "row_count": 0,
            "rows_truncated": False,
            "duration_ms": 10000,
            "error": "statement timeout",
        }
    ),
    RenderExpectedSentenceInput(oracle_result_id=ORACLE_RESULT_ID),
    RenderExpectedSentenceResult(sentence="2 rooms", error=None),
    RenderExpectedSentenceResult(sentence=None, error="undefined variable rows"),
    ResolveGoldPointsInput(run_scenario_id=RUN_SCENARIO_ID, attempt=0, step_index=2),
    ResolveGoldPointsResult.model_validate({"gold_points": [EXAMPLES["GoldPoint"]]}),
    CheckDbExpectationInput(step_id=STEP_ID),
    CheckDbExpectationResult.model_validate({"db_checks": [EXAMPLES["DbCheck"]]}),
    ResolveClockInput(target_id=TARGET_ID),
    ResolveClockResult.model_validate({"mode": "pinned", "at": "2026-10-05T09:00:00.000Z"}),
    GradeStepInput(step_id=STEP_ID, run_id=RUN_ID, policy=POLICY),
    GradeStepResult.model_validate(
        {"verdict": VERDICT, "escalated_to": "judge", "spent_usd": 0.004321}
    ),
    GradeStepResult.model_validate(
        {
            "verdict": {**VERDICT, "tier": "code", "confidence": None},
            "escalated_to": None,
            "spent_usd": 0.0,
        }
    ),
    RunLayaProbesInput(step_id=STEP_ID, probe_ids=["no_internal_ids"]),
    ProbeBatchResult.model_validate(
        {"results": [EXAMPLES["ProbeResult"], EXAMPLES["ProbeResultError"]]}
    ),
    JUDGE_INPUT,
    JudgeStepOutput.model_validate(
        {
            "verdict": VERDICT,
            "rationale": "The count differs.",
            "evidence": EXAMPLES["JudgeResult"]["evidence"],
            "judge_result_id": str(JUDGE_RESULT_ID),
            "cost_usd": 0.004321,
            "input_tokens": 1800,
            "output_tokens": 210,
            "swapped_agrees": True,
        }
    ),
    StoreWeakLabelInput(judge_result_id=JUDGE_RESULT_ID),
    StoreWeakLabelResult(label_id=UUID("0198f6f2-7b00-7a00-9d00-0000000000e2")),
]


@pytest.mark.parametrize("sample", SAMPLES, ids=lambda sample: type(sample).__name__)
async def test_models_survive_the_temporal_pydantic_converter(sample: BaseModel) -> None:
    payloads = await pydantic_data_converter.encode([sample])
    [decoded] = await pydantic_data_converter.decode(payloads, [type(sample)])
    assert decoded == sample
    assert len(payloads[0].data) < MAX_PAYLOAD_BYTES


def test_stage_three_and_four_names_are_the_contract_names() -> None:
    assert temporal.SEED_TARGET_WORKFLOW == "SeedTarget"
    assert temporal.RUN_ORACLE_WORKFLOW == "RunOracle"
    assert temporal.GRADE_STEP_WORKFLOW == "GradeStep"
    activities = [
        (temporal.LOAD_SEED_MATERIAL_ACTIVITY, "load_seed_material"),
        (temporal.EXECUTE_RESET_SCRIPT_ACTIVITY, "execute_reset_script"),
        (temporal.RUN_HASH_COMMAND_ACTIVITY, "run_hash_command"),
        (temporal.EXECUTE_ORACLE_QUERY_ACTIVITY, "execute_oracle_query"),
        (temporal.RENDER_EXPECTED_SENTENCE_ACTIVITY, "render_expected_sentence"),
        (temporal.RESOLVE_GOLD_POINTS_ACTIVITY, "resolve_gold_points"),
        (temporal.CHECK_DB_EXPECTATION_ACTIVITY, "check_db_expectation"),
        (temporal.RESOLVE_CLOCK_ACTIVITY, "resolve_clock"),
        (temporal.RUN_LAYA_PROBES_ACTIVITY, "run_laya_probes"),
        (temporal.JUDGE_STEP_ACTIVITY, "judge_step"),
        (temporal.JUDGE_TIEBREAK_ACTIVITY, "judge_tiebreak"),
        (temporal.STORE_WEAK_LABEL_ACTIVITY, "store_weak_label"),
    ]
    assert all(name == expected for name, expected in activities)
    assert len({name for name, _ in activities}) == 12


def test_no_stage_three_or_four_name_collides_with_a_stage_two_name() -> None:
    names = [
        value
        for key, value in vars(temporal).items()
        if key.endswith(("_ACTIVITY", "_WORKFLOW")) and isinstance(value, str)
    ]
    assert len(names) == len(set(names))
    assert len(names) >= 3 + 3 + 9 + 12


def test_workflow_ids_derive_from_resource_ids() -> None:
    assert seed_target_workflow_id(RUN_ID) == f"seed-{RUN_ID}"
    assert run_oracle_workflow_id(ORACLE_RESULT_ID) == f"run-oracle-{ORACLE_RESULT_ID}"
    assert grade_step_workflow_id(STEP_ID) == f"grade-step-{STEP_ID}"


def test_the_retry_and_timeout_constants_follow_the_plan_tables() -> None:
    assert temporal.SEED_SCRIPT_START_TO_CLOSE_MARGIN.total_seconds() == 30
    assert temporal.SEED_SCRIPT_MAX_ATTEMPTS == 1
    assert temporal.ORACLE_QUERY_START_TO_CLOSE.total_seconds() == 120
    assert temporal.ORACLE_QUERY_MAX_ATTEMPTS == 1
    assert temporal.LAYA_PROBES_START_TO_CLOSE.total_seconds() == 30
    assert temporal.JUDGE_START_TO_CLOSE.total_seconds() == 60
    assert temporal.JUDGE_MAX_ATTEMPTS == 2
    assert temporal.PLAIN_ACTIVITY_START_TO_CLOSE.total_seconds() == 30
    assert temporal.PLAIN_ACTIVITY_MAX_ATTEMPTS == 3


@pytest.mark.parametrize(
    ("model", "fields"),
    [
        (SeedTargetInput, {"run_id", "target_id", "seed_id", "action"}),
        (SeedTargetResult, {"matched", "observed_hash", "expected_hash"}),
        (RunOracleInput, {"oracle_result_id"}),
        (RunOracleResult, {"status"}),
        (LoadSeedMaterialInput, {"seed_id"}),
        (
            LoadSeedMaterialResult,
            {"reset_script_ref", "hash_command_ref", "script_timeout_seconds"},
        ),
        (ExecuteResetScriptInput, {"run_id", "seed_id"}),
        (ExecuteResetScriptResult, {"exit_code", "output_excerpt"}),
        (RunHashCommandInput, {"seed_id"}),
        (RunHashCommandResult, {"observed_hash"}),
        (ExecuteOracleQueryInput, {"oracle_result_id"}),
        (
            ExecuteOracleQueryResult,
            {"status", "row_count", "rows_truncated", "duration_ms", "error"},
        ),
        (RenderExpectedSentenceInput, {"oracle_result_id"}),
        (RenderExpectedSentenceResult, {"sentence", "error"}),
        (ResolveGoldPointsInput, {"run_scenario_id", "attempt", "step_index"}),
        (ResolveGoldPointsResult, {"gold_points", "blocked"}),
        (CheckDbExpectationInput, {"step_id"}),
        (CheckDbExpectationResult, {"db_checks", "verdict"}),
        (ResolveClockInput, {"target_id", "bundle_id"}),
        (GradeStepInput, {"step_id", "run_id", "policy"}),
        (GradeStepResult, {"verdict", "escalated_to", "spent_usd"}),
        (RunLayaProbesInput, {"step_id", "probe_ids"}),
        (
            JudgeStepInput,
            {"step_id", "evidence", "order", "spec", "paired_with"},
        ),
        (
            JudgeStepOutput,
            {
                "verdict",
                "rationale",
                "evidence",
                "judge_result_id",
                "cost_usd",
                "input_tokens",
                "output_tokens",
                "swapped_agrees",
            },
        ),
        (StoreWeakLabelInput, {"judge_result_id"}),
        (StoreWeakLabelResult, {"label_id"}),
        (
            SeedAssertionResult,
            {"outcome", "seed_hash", "observed_hash", "expected_hash", "reason"},
        ),
    ],
)
def test_the_models_carry_exactly_the_contract_fields_plus_the_documented_additions(
    model: type[BaseModel], fields: set[str]
) -> None:
    assert set(model.model_fields) == fields


def test_the_contract_aliases_point_at_the_shared_models() -> None:
    assert ResolveClockResult is ClockSnapshot
    assert JudgeTiebreakInput is JudgeStepInput
    assert JudgeTiebreakOutput is JudgeStepOutput
    assert RunLayaProbesResult is ProbeBatchResult


def test_the_seed_assertion_never_reports_an_unverified_seed_as_matched() -> None:
    with pytest.raises(ValidationError):
        SeedAssertionResult.model_validate(
            {
                "outcome": "verified",
                "seed_hash": None,
                "observed_hash": None,
                "expected_hash": None,
                "reason": None,
            }
        )


def test_a_seed_action_is_verify_or_reset_only() -> None:
    with pytest.raises(ValidationError):
        SeedTargetInput.model_validate(
            {
                "run_id": str(RUN_ID),
                "target_id": str(TARGET_ID),
                "seed_id": str(SEED_ID),
                "action": "wipe",
            }
        )


def test_the_script_timeout_travels_in_the_material_result_and_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        LoadSeedMaterialResult(
            reset_script_ref=None, hash_command_ref=None, script_timeout_seconds=0
        )


def test_an_oracle_query_result_never_carries_the_rows() -> None:
    assert "rows" not in ExecuteOracleQueryResult.model_fields
