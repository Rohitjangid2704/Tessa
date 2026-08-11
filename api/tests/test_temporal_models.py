import json
from typing import Any
from uuid import UUID

import pytest
from pydantic import BaseModel, ValidationError
from temporalio.contrib.pydantic import pydantic_data_converter

from tessa_api.schemas import temporal
from tessa_api.schemas.enums import RunStatus
from tessa_api.schemas.temporal import (
    AttemptResult,
    CreateRunScenariosInput,
    CreateRunScenariosResult,
    DriveAttemptInput,
    ExecuteRunInput,
    ExecuteRunProgress,
    ExecuteRunResult,
    ExpandCellsInput,
    ExpandCellsResult,
    FinalizeRunInput,
    FinalizeRunResult,
    GenerateSmokeScenarioInput,
    GenerateSmokeScenarioResult,
    LoadRunContextInput,
    PlanCoverageInput,
    PlanCoverageProgress,
    PlanCoverageResult,
    RunContext,
    RunScenarioInput,
    RunScenarioRef,
    RunScenarioResult,
    RunTier0ChecksInput,
    UpdateRunStatusInput,
    UpdateRunStatusResult,
    ValidateScenarioInput,
    ValidateScenarioResult,
    execute_run_workflow_id,
    plan_coverage_workflow_id,
    run_scenario_workflow_id,
)

RUN_ID = UUID("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11")
RUN_SCENARIO_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000001")
SCENARIO_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000002")
PLAN_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000003")
CELL_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000004")
BUNDLE_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000005")
TARGET_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000006")
USER_ID = UUID("0198f6f2-7b00-7a00-9d00-000000000007")
SESSION_ID = UUID("0198f6f2-9d00-7a00-9d00-0000000000b1")
MAX_PAYLOAD_BYTES = 256 * 1024

COUNTERS: dict[str, Any] = {
    "scenarios_total": 4,
    "scenarios_done": 1,
    "pass": 1,
    "fail": 0,
    "flaky": 0,
    "uncertain": 0,
    "skipped": 0,
    "steps_recorded": 6,
}
VERDICT: dict[str, Any] = {
    "status": "pass",
    "tier": "code",
    "confidence": None,
    "reason_code": None,
    "reason": None,
    "skip_reason": None,
}
SNAPSHOT: dict[str, Any] = {
    "bundle_id": str(BUNDLE_ID),
    "bundle_version": 2,
    "bundle_hash": "abc123",
    "seed_hash": None,
    "clock": None,
    "models": None,
    "probe_bank_version": None,
    "prompt_template_versions": {"discovery": 1},
    "scenario_versions": {str(SCENARIO_ID): 1},
}
PLAN: dict[str, Any] = {
    "id": str(PLAN_ID),
    "target_id": str(TARGET_ID),
    "bundle_id": str(BUNDLE_ID),
    "name": None,
    "saved": False,
    "selection": {
        "feature_ids": ["smart_log.read.open_maintenance"],
        "area_ids": [],
        "roles": ["all"],
        "interface_mode": "both",
        "depth": "smoke",
        "k": 3,
        "budget": None,
    },
    "effective_budget": {"max_usd": 5.0, "max_minutes": 30},
    "is_coverage_baseline": False,
    "cells_total": 2,
    "schedule_id": None,
    "created_by": str(USER_ID),
    "created_at": "2026-10-05T09:00:00.000Z",
}

SAMPLES: list[BaseModel] = [
    ExecuteRunInput(run_id=RUN_ID),
    ExecuteRunResult.model_validate(
        {"status": "completed", "counters": COUNTERS, "spent_usd": 0.0}
    ),
    ExecuteRunProgress.model_validate(
        {
            "counters": COUNTERS,
            "budget": {"max_usd": 5.0, "spent_usd": 0.0, "max_minutes": 30, "elapsed_ms": 10},
        }
    ),
    RunScenarioInput(
        run_id=RUN_ID,
        run_scenario_id=RUN_SCENARIO_ID,
        attempts=3,
        read_only=False,
        mode="live",
        timeout_seconds=300,
    ),
    RunScenarioResult.model_validate(
        {
            "run_scenario_id": str(RUN_SCENARIO_ID),
            "verdict": VERDICT,
            "attempts": [{"attempt": 0, "status": "finished", "verdict": VERDICT}],
            "spent_usd": 0.0,
        }
    ),
    PlanCoverageInput(plan_id=PLAN_ID, run_id=RUN_ID, cell_ids=[CELL_ID]),
    PlanCoverageInput(plan_id=PLAN_ID, run_id=RUN_ID),
    PlanCoverageResult(cells_total=2, scenarios_created=2, scenarios_reused=0, scenarios_invalid=0),
    PlanCoverageProgress(
        cells_total=2, cells_done=1, scenarios_created=1, scenarios_reused=0, scenarios_invalid=0
    ),
    DriveAttemptInput(run_id=RUN_ID, run_scenario_id=RUN_SCENARIO_ID, attempt=0, read_only=True),
    AttemptResult.model_validate(
        {
            "status": "finished",
            "steps_recorded": 3,
            "cost_usd": 0.0,
            "browser_session_id": str(SESSION_ID),
            "verdict": VERDICT,
            "error": None,
        }
    ),
    AttemptResult.model_validate(
        {
            "status": "errored",
            "steps_recorded": 1,
            "cost_usd": 0.0,
            "browser_session_id": None,
            "verdict": None,
            "error": "ConnectError",
        }
    ),
    ExpandCellsInput(plan_id=PLAN_ID),
    ExpandCellsResult(cell_ids=[CELL_ID]),
    GenerateSmokeScenarioInput(cell_id=CELL_ID),
    GenerateSmokeScenarioResult(scenario_ids=[SCENARIO_ID]),
    ValidateScenarioInput(scenario_id=SCENARIO_ID),
    ValidateScenarioResult.model_validate(
        {
            "valid": False,
            "errors": [
                {
                    "code": "unknown_role",
                    "pointer": "/role",
                    "line": 6,
                    "column": 7,
                    "message": "no role",
                }
            ],
            "warnings": [],
        }
    ),
    CreateRunScenariosInput(run_id=RUN_ID),
    CreateRunScenariosResult(run_scenario_ids=[RUN_SCENARIO_ID]),
    LoadRunContextInput(run_id=RUN_ID),
    RunContext.model_validate(
        {
            "config_snapshot": SNAPSHOT,
            "plan": PLAN,
            "run_scenarios": [
                {"id": str(RUN_SCENARIO_ID), "attempts_total": 3, "timeout_seconds": 300}
            ],
            "read_only": False,
            "max_concurrency": 4,
            "budget": {"max_usd": 5.0, "max_minutes": 30},
        }
    ),
    UpdateRunStatusInput(run_id=RUN_ID, status=RunStatus.running, reason=None),
    UpdateRunStatusResult(),
    FinalizeRunInput(run_id=RUN_ID),
    FinalizeRunResult.model_validate({"counters": COUNTERS, "spent_usd": 0.0, "duration_ms": 1000}),
    RunTier0ChecksInput(step_id=SCENARIO_ID),
]


@pytest.mark.parametrize("sample", SAMPLES, ids=lambda sample: type(sample).__name__)
async def test_models_survive_the_temporal_pydantic_converter(sample: BaseModel) -> None:
    converter = pydantic_data_converter
    payloads = await converter.encode([sample])
    [decoded] = await converter.decode(payloads, [type(sample)])
    assert decoded == sample
    assert len(payloads[0].data) < MAX_PAYLOAD_BYTES


def test_workflow_and_activity_names_are_the_contract_names() -> None:
    assert temporal.EXECUTE_RUN_WORKFLOW == "ExecuteRun"
    assert temporal.RUN_SCENARIO_WORKFLOW == "RunScenario"
    assert temporal.PLAN_COVERAGE_WORKFLOW == "PlanCoverage"
    assert temporal.CANCEL_SIGNAL == "cancel"
    assert temporal.PROGRESS_QUERY == "progress"
    activities = [
        (temporal.EXPAND_CELLS_ACTIVITY, "expand_cells"),
        (temporal.GENERATE_SMOKE_SCENARIO_ACTIVITY, "generate_smoke_scenario"),
        (temporal.VALIDATE_SCENARIO_ACTIVITY, "validate_scenario"),
        (temporal.CREATE_RUN_SCENARIOS_ACTIVITY, "create_run_scenarios"),
        (temporal.LOAD_RUN_CONTEXT_ACTIVITY, "load_run_context"),
        (temporal.UPDATE_RUN_STATUS_ACTIVITY, "update_run_status"),
        (temporal.FINALIZE_RUN_ACTIVITY, "finalize_run"),
        (temporal.DRIVE_SCENARIO_ATTEMPT_ACTIVITY, "drive_scenario_attempt"),
        (temporal.RUN_TIER0_CHECKS_ACTIVITY, "run_tier0_checks"),
    ]
    assert all(name == expected for name, expected in activities)
    assert len({name for name, _ in activities}) == 9


def test_workflow_ids_derive_from_resource_ids() -> None:
    assert execute_run_workflow_id(RUN_ID) == f"execute-run-{RUN_ID}"
    assert plan_coverage_workflow_id(RUN_ID) == f"plan-coverage-{RUN_ID}"
    assert run_scenario_workflow_id(RUN_SCENARIO_ID) == f"run-scenario-{RUN_SCENARIO_ID}"


def test_the_retry_and_timeout_constants_follow_the_plan_table() -> None:
    assert temporal.PLAIN_ACTIVITY_START_TO_CLOSE.total_seconds() == 30
    assert temporal.PLAIN_ACTIVITY_MAX_ATTEMPTS == 3
    assert temporal.DRIVE_START_TO_CLOSE_MARGIN.total_seconds() == 60
    assert temporal.DRIVE_HEARTBEAT_INTERVAL.total_seconds() == 10
    assert temporal.DRIVE_HEARTBEAT_TIMEOUT.total_seconds() == 30
    assert temporal.DRIVE_MAX_ATTEMPTS == 1
    assert temporal.PROGRESS_EVENT_MIN_INTERVAL.total_seconds() == 2


@pytest.mark.parametrize(
    ("model", "fields"),
    [
        (ExecuteRunInput, {"run_id", "max_concurrency", "reset_seed", "owns_run"}),
        (ExecuteRunResult, {"status", "counters", "spent_usd", "reason"}),
        (
            RunScenarioInput,
            {
                "run_id",
                "run_scenario_id",
                "attempts",
                "read_only",
                "mode",
                "timeout_seconds",
                "code_laya_only",
            },
        ),
        (RunScenarioResult, {"run_scenario_id", "verdict", "attempts", "spent_usd"}),
        (
            PlanCoverageInput,
            {"plan_id", "run_id", "cell_ids", "mode", "scenario_ids"},
        ),
        (
            PlanCoverageResult,
            {
                "cells_total",
                "scenarios_created",
                "scenarios_reused",
                "scenarios_invalid",
                "dry_run_failures",
            },
        ),
        (DriveAttemptInput, {"run_id", "run_scenario_id", "attempt", "read_only"}),
        (
            AttemptResult,
            {"status", "steps_recorded", "cost_usd", "browser_session_id", "verdict", "error"},
        ),
        (ExpandCellsInput, {"plan_id"}),
        (ExpandCellsResult, {"cell_ids"}),
        (GenerateSmokeScenarioInput, {"cell_id"}),
        (GenerateSmokeScenarioResult, {"scenario_ids"}),
        (ValidateScenarioInput, {"scenario_id"}),
        (CreateRunScenariosInput, {"run_id"}),
        (CreateRunScenariosResult, {"run_scenario_ids"}),
        (LoadRunContextInput, {"run_id"}),
        (
            RunContext,
            {"config_snapshot", "plan", "run_scenarios", "read_only", "max_concurrency", "budget"},
        ),
        (RunScenarioRef, {"id", "attempts_total", "timeout_seconds"}),
        (UpdateRunStatusInput, {"run_id", "status", "reason"}),
        (FinalizeRunInput, {"run_id"}),
        (FinalizeRunResult, {"counters", "spent_usd", "duration_ms"}),
        (RunTier0ChecksInput, {"step_id"}),
    ],
)
def test_models_carry_the_fields_the_contract_lists(
    model: type[BaseModel], fields: set[str]
) -> None:
    assert set(model.model_fields) == fields


def test_the_attempt_mode_is_live_or_dry_run() -> None:
    with pytest.raises(ValidationError):
        RunScenarioInput.model_validate(
            {
                "run_id": str(RUN_ID),
                "run_scenario_id": str(RUN_SCENARIO_ID),
                "attempts": 1,
                "read_only": False,
                "mode": "replay",
                "timeout_seconds": 10,
            }
        )


def test_the_validation_activity_returns_the_scenario_validation_shape() -> None:
    assert set(ValidateScenarioResult.model_fields) == {"valid", "errors", "warnings"}


def test_workflow_payloads_carry_ids_only_no_free_text_or_secrets() -> None:
    for sample in SAMPLES:
        text = json.dumps(json.loads(sample.model_dump_json())).lower()
        for forbidden in ("password", "secret", "api_key", "vault"):
            assert forbidden not in text
