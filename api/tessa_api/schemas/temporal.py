from datetime import timedelta
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, JsonValue, field_validator, model_validator

from tessa_api.schemas.common import (
    EMBEDDING_DIMENSIONS,
    Budget,
    BudgetState,
    Probability,
    RunCounters,
    Verdict,
)
from tessa_api.schemas.enums import (
    DedupeMode,
    FindingClass,
    GoalKind,
    InvariantPack,
    MutationOutcome,
    OracleResultStatus,
    ReportChannel,
    RunScenarioStatus,
    RunStatus,
    SecretName,
    SeedAction,
    SeedPhase,
    SeedPhaseStatus,
    Severity,
    SkipReason,
    VerdictTier,
)
from tessa_api.schemas.explore_actions import ExploreAction
from tessa_api.schemas.goals import (
    CRITERIA_MAX_COUNT,
    GOAL_ROLE_MAX_LENGTH,
    GOAL_STATEMENT_MAX_LENGTH,
)
from tessa_api.schemas.grading import (
    GradePolicy,
    JudgeStepInput,
    JudgeStepOutput,
    ModelCallSpec,
    ModelUsage,
    ProbeBatchResult,
)
from tessa_api.schemas.invariants import InvariantResult
from tessa_api.schemas.model_calls import (
    EMBED_MAX_TEXT_CHARS,
    EMBED_MAX_TEXTS_PER_CALL,
    EmbedCallSpec,
    ModelCallRecord,
)
from tessa_api.schemas.mutation import MutationOutcomeItem
from tessa_api.schemas.notifications import NotificationContent
from tessa_api.schemas.oracles import DbCheck, GoldPoint
from tessa_api.schemas.plans import Plan
from tessa_api.schemas.redteam import FamilyId
from tessa_api.schemas.retention import RetentionSweepCounts
from tessa_api.schemas.runs import ClockSnapshot, RunConfigSnapshot, RunScenarioAttempt
from tessa_api.schemas.scenarios import ScenarioValidation
from tessa_api.schemas.sim import SimChecks
from tessa_api.schemas.steps import Tier0Result

EXECUTE_RUN_WORKFLOW = "ExecuteRun"
RUN_SCENARIO_WORKFLOW = "RunScenario"
PLAN_COVERAGE_WORKFLOW = "PlanCoverage"

CANCEL_SIGNAL = "cancel"
PROGRESS_QUERY = "progress"

EXPAND_CELLS_ACTIVITY = "expand_cells"
GENERATE_SMOKE_SCENARIO_ACTIVITY = "generate_smoke_scenario"
VALIDATE_SCENARIO_ACTIVITY = "validate_scenario"
CREATE_RUN_SCENARIOS_ACTIVITY = "create_run_scenarios"
LOAD_RUN_CONTEXT_ACTIVITY = "load_run_context"
UPDATE_RUN_STATUS_ACTIVITY = "update_run_status"
FINALIZE_RUN_ACTIVITY = "finalize_run"
DRIVE_SCENARIO_ATTEMPT_ACTIVITY = "drive_scenario_attempt"
RUN_TIER0_CHECKS_ACTIVITY = "run_tier0_checks"

SEED_TARGET_WORKFLOW = "SeedTarget"
RUN_ORACLE_WORKFLOW = "RunOracle"
GRADE_STEP_WORKFLOW = "GradeStep"
TRIAGE_FINDINGS_WORKFLOW = "TriageFindings"
FUZZ_FAMILY_WORKFLOW = "FuzzFamily"
MUTATION_RUN_WORKFLOW = "MutationRun"
SCHEDULED_RUN_WORKFLOW = "ScheduledRun"
BUILD_REPORT_WORKFLOW = "BuildReport"
RETENTION_SWEEP_WORKFLOW = "RetentionSweep"
AUTOMATE_ROUND_TRIP_WORKFLOW = "AutomateRoundTrip"
RETENTION_SWEEP_SCHEDULE_ID = "retention-sweep"
RETENTION_SWEEP_WORKFLOW_ID = "retention-sweep"


EVALUATE_INVARIANTS_ACTIVITY = "evaluate_invariants"
ENSURE_INVARIANT_SCENARIOS_ACTIVITY = "ensure_invariant_scenarios"
FINGERPRINT_FINDINGS_ACTIVITY = "fingerprint_findings"
EMBED_TEXTS_ACTIVITY = "embed_texts"
DEDUPE_FINDINGS_ACTIVITY = "dedupe_findings"
UPSERT_FINDINGS_ACTIVITY = "upsert_findings"
BUILD_REPRO_BUNDLE_ACTIVITY = "build_repro_bundle"
RESOLVE_MODEL_SPECS_ACTIVITY = "resolve_model_specs"
RECORD_MODEL_CALL_ACTIVITY = "record_model_call"
DRY_RUN_SCENARIO_ACTIVITY = "dry_run_scenario"
IMPORT_AUTHORED_SCENARIOS_ACTIVITY = "import_authored_scenarios"
RUN_SCHEMATHESIS_ACTIVITY = "run_schemathesis"
PREPARE_FUZZ_FAMILY_ACTIVITY = "prepare_fuzz_family"

GET_WORKER_TASK_QUEUE_ACTIVITY = "get_worker_task_queue"
OPEN_BROWSER_SESSION_ACTIVITY = "open_browser_session"
CLOSE_BROWSER_SESSION_ACTIVITY = "close_browser_session"
EXECUTE_ACTION_ACTIVITY = "execute_action"
VERIFY_BY_REPLAY_ACTIVITY = "verify_by_replay"
SEND_TARGET_TURN_ACTIVITY = "send_target_turn"
CHECK_SIMULATION_ACTIVITY = "check_simulation"
SKEPTIC_VERIFY_ACTIVITY = "skeptic_verify"

SCORE_MUTATION_ACTIVITY = "score_mutation"
APPLY_FLAKINESS_POLICY_ACTIVITY = "apply_flakiness_policy"
RENDER_REPORT_ACTIVITY = "render_report"
SEND_SLACK_ACTIVITY = "send_slack"
CREATE_NOTIFICATION_ACTIVITY = "create_notification"


LOAD_SEED_MATERIAL_ACTIVITY = "load_seed_material"
EXECUTE_RESET_SCRIPT_ACTIVITY = "execute_reset_script"
RUN_HASH_COMMAND_ACTIVITY = "run_hash_command"
EXECUTE_ORACLE_QUERY_ACTIVITY = "execute_oracle_query"
RENDER_EXPECTED_SENTENCE_ACTIVITY = "render_expected_sentence"
RESOLVE_GOLD_POINTS_ACTIVITY = "resolve_gold_points"
CHECK_DB_EXPECTATION_ACTIVITY = "check_db_expectation"
RESOLVE_CLOCK_ACTIVITY = "resolve_clock"
RUN_LAYA_PROBES_ACTIVITY = "run_laya_probes"
JUDGE_STEP_ACTIVITY = "judge_step"
JUDGE_TIEBREAK_ACTIVITY = "judge_tiebreak"
STORE_WEAK_LABEL_ACTIVITY = "store_weak_label"

PLAIN_ACTIVITY_START_TO_CLOSE = timedelta(seconds=30)
PLAIN_ACTIVITY_MAX_ATTEMPTS = 3
DRIVE_START_TO_CLOSE_MARGIN = timedelta(seconds=60)
DRIVE_HEARTBEAT_INTERVAL = timedelta(seconds=10)
DRIVE_HEARTBEAT_TIMEOUT = timedelta(seconds=30)
DRIVE_MAX_ATTEMPTS = 1
PROGRESS_EVENT_MIN_INTERVAL = timedelta(seconds=2)
SEED_SCRIPT_START_TO_CLOSE_MARGIN = timedelta(seconds=30)
SEED_SCRIPT_MAX_ATTEMPTS = 1
ORACLE_QUERY_START_TO_CLOSE = timedelta(seconds=120)
ORACLE_QUERY_MAX_ATTEMPTS = 1
LAYA_PROBES_START_TO_CLOSE = timedelta(seconds=30)
LAYA_PROBES_MAX_ATTEMPTS = 2
JUDGE_START_TO_CLOSE = timedelta(seconds=60)
JUDGE_MAX_ATTEMPTS = 2
INVARIANTS_START_TO_CLOSE = timedelta(seconds=60)
FINDINGS_START_TO_CLOSE = timedelta(seconds=60)
EMBED_START_TO_CLOSE = timedelta(seconds=30)
EMBED_MAX_ATTEMPTS = 3
DRY_RUN_TIMEOUT_FACTOR = 2
DRY_RUN_START_TO_CLOSE_MARGIN = timedelta(seconds=60)
FUZZ_START_TO_CLOSE_MARGIN = timedelta(seconds=60)
FUZZ_HEARTBEAT_TIMEOUT = timedelta(seconds=60)
FUZZ_MAX_ATTEMPTS = 1
FINDING_TRIAGE_BATCH_SIZE = EMBED_MAX_TEXTS_PER_CALL
SESSION_QUEUE_LOOKUP_START_TO_CLOSE = timedelta(seconds=10)
SESSION_QUEUE_LOOKUP_MAX_ATTEMPTS = 3
SESSION_ACTIVITY_START_TO_CLOSE_MARGIN = timedelta(seconds=30)
SESSION_ACTIVITY_MAX_ATTEMPTS = 1
SESSION_CLOSE_START_TO_CLOSE = timedelta(seconds=30)
SESSION_CLOSE_MAX_ATTEMPTS = 3
MUTATION_ACTIVITY_START_TO_CLOSE = timedelta(seconds=60)
MUTATION_ACTIVITY_MAX_ATTEMPTS = 3
FLAKINESS_START_TO_CLOSE = timedelta(seconds=60)
FLAKINESS_MAX_ATTEMPTS = 3
REPORT_START_TO_CLOSE = timedelta(seconds=60)
REPORT_MAX_ATTEMPTS = 3
NOTIFY_SEND_START_TO_CLOSE = timedelta(seconds=30)
NOTIFY_SEND_MAX_ATTEMPTS = 5
SCHEDULE_CATCHUP_WINDOW = timedelta(hours=1)
SLACK_TEXT_MAX_CHARS = 3000
SLACK_LINK_MAX_CHARS = 2000
SKEPTIC_TEXT_MAX_CHARS = 8000
SIM_TURN_TEXT_MAX_CHARS = 2000
SESSION_QUEUE_SEPARATOR = "-w-"


def execute_run_workflow_id(run_id: UUID) -> str:
    return f"execute-run-{run_id}"


def plan_coverage_workflow_id(run_id: UUID) -> str:
    return f"plan-coverage-{run_id}"


def run_scenario_workflow_id(run_scenario_id: UUID) -> str:
    return f"run-scenario-{run_scenario_id}"


def seed_target_workflow_id(run_id: UUID) -> str:
    return f"seed-{run_id}"


def run_oracle_workflow_id(oracle_result_id: UUID) -> str:
    return f"run-oracle-{oracle_result_id}"


def grade_step_workflow_id(step_id: UUID) -> str:
    return f"grade-step-{step_id}"


def triage_findings_workflow_id(run_id: UUID) -> str:
    return f"triage-findings-{run_id}"


def fuzz_family_workflow_id(run_id: UUID) -> str:
    return f"fuzz-family-{run_id}"


def mutation_workflow_id(run_id: UUID) -> str:
    return f"mutation-{run_id}"


def build_report_workflow_id(run_id: UUID) -> str:
    return f"build-report-{run_id}"


def temporal_schedule_id(schedule_id: UUID) -> str:
    return f"schedule-{schedule_id}"


def scheduled_run_workflow_id(schedule_id: UUID) -> str:
    return f"scheduled-run-{schedule_id}"


def scheduled_run_now_workflow_id(schedule_id: UUID, run_id: UUID) -> str:
    return f"{scheduled_run_workflow_id(schedule_id)}-now-{run_id}"


def session_task_queue(base_queue: str, worker_id: str) -> str:
    return f"{base_queue}{SESSION_QUEUE_SEPARATOR}{worker_id}"


class ExecuteRunInput(BaseModel):
    run_id: UUID
    max_concurrency: int | None = Field(
        default=None,
        ge=1,
        description="scenarios to run at once, already capped by the API; absent uses the "
        "worker default",
    )
    reset_seed: bool = Field(
        default=False,
        description="true resets the seed before the run asserts its hash (RunCreate.reset_seed)",
    )
    owns_run: bool = Field(
        default=True,
        description="false when the parent workflow concludes the run: ExecuteRun then writes no "
        "terminal status, triages no findings and reports the outcome in its result",
    )


class ExecuteRunResult(BaseModel):
    status: RunStatus
    counters: RunCounters
    spent_usd: float = Field(ge=0)
    reason: str | None = Field(
        default=None, description="why the run ended the way it did; null when nothing needs saying"
    )


class ExecuteRunProgress(BaseModel):
    counters: RunCounters
    budget: BudgetState


class RunScenarioInput(BaseModel):
    run_id: UUID
    run_scenario_id: UUID
    attempts: int = Field(ge=1, description="attempts to run, from the plan k")
    read_only: bool = Field(description="true on production targets; write steps are skipped")
    mode: Literal["live", "dry_run"]
    timeout_seconds: int = Field(
        ge=1, description="scenario timeout the drive activity timeout derives from"
    )
    code_laya_only: bool = Field(
        default=False,
        description="true grades the steps with code and Laya only, no judge model (commit tier)",
    )


class RunScenarioResult(BaseModel):
    run_scenario_id: UUID
    verdict: Verdict
    attempts: list[RunScenarioAttempt]
    spent_usd: float = Field(ge=0)


class PlanCoverageInput(BaseModel):
    plan_id: UUID
    run_id: UUID
    cell_ids: list[UUID] | None = Field(
        default=None, description="limit planning to these cells; absent plans every cell"
    )
    mode: Literal["smoke", "dry_run"] = Field(
        default="smoke",
        description="smoke expands bundle examples; dry_run dry-runs the listed scenarios",
    )
    scenario_ids: list[UUID] | None = Field(
        default=None,
        description="the imported scenarios a dry_run run dry-runs; the generate run that "
        "bundle intake starts sets them",
    )

    @model_validator(mode="after")
    def require_scenarios_for_a_dry_run(self) -> Self:
        if self.mode == "dry_run" and self.scenario_ids is None:
            raise ValueError("a dry_run needs scenario_ids")
        return self


class PlanCoverageResult(BaseModel):
    cells_total: int = Field(ge=0)
    scenarios_created: int = Field(ge=0)
    scenarios_reused: int = Field(ge=0)
    scenarios_invalid: int = Field(ge=0)
    dry_run_failures: int = Field(
        default=0, ge=0, description="scenarios whose dry runs did not both pass"
    )


class PlanCoverageProgress(BaseModel):
    cells_total: int = Field(ge=0)
    cells_done: int = Field(ge=0)
    scenarios_created: int = Field(ge=0)
    scenarios_reused: int = Field(ge=0)
    scenarios_invalid: int = Field(ge=0)


class DriveAttemptInput(BaseModel):
    run_id: UUID
    run_scenario_id: UUID
    attempt: int = Field(ge=0)
    read_only: bool


class AttemptResult(BaseModel):
    status: RunScenarioStatus
    steps_recorded: int = Field(ge=0)
    cost_usd: float = Field(ge=0)
    browser_session_id: UUID | None
    verdict: Verdict | None = Field(
        description="code verdict of the attempt; null when the attempt errored or was canceled"
    )
    error: str | None = Field(description="short redacted reason when the attempt errored")


class ExpandCellsInput(BaseModel):
    plan_id: UUID


class ExpandCellsResult(BaseModel):
    cell_ids: list[UUID]


class GenerateSmokeScenarioInput(BaseModel):
    cell_id: UUID


class GenerateSmokeScenarioResult(BaseModel):
    scenario_ids: list[UUID]


class ValidateScenarioInput(BaseModel):
    scenario_id: UUID


ValidateScenarioResult = ScenarioValidation


class CreateRunScenariosInput(BaseModel):
    run_id: UUID


class CreateRunScenariosResult(BaseModel):
    run_scenario_ids: list[UUID]


class LoadRunContextInput(BaseModel):
    run_id: UUID


class RunScenarioRef(BaseModel):
    id: UUID = Field(description="run scenario id")
    attempts_total: int = Field(ge=1)
    timeout_seconds: int = Field(ge=1)


class RunContext(BaseModel):
    config_snapshot: RunConfigSnapshot
    plan: Plan
    run_scenarios: list[RunScenarioRef] = Field(
        description="run scenarios still to run, with what the workflow needs to schedule them"
    )
    read_only: bool
    max_concurrency: int = Field(ge=1)
    budget: Budget


class UpdateRunStatusInput(BaseModel):
    run_id: UUID
    status: RunStatus
    reason: str | None = None


class UpdateRunStatusResult(BaseModel):
    pass


class FinalizeRunInput(BaseModel):
    run_id: UUID


class FinalizeRunResult(BaseModel):
    counters: RunCounters
    spent_usd: float = Field(ge=0)
    duration_ms: int = Field(ge=0)


class RunTier0ChecksInput(BaseModel):
    step_id: UUID


RunTier0ChecksResult = Tier0Result


class SeedTargetInput(BaseModel):
    run_id: UUID = Field(
        description="run the seed events belong to: the seed run, or the suite run for a child"
    )
    target_id: UUID
    seed_id: UUID
    action: SeedAction


class SeedTargetResult(BaseModel):
    matched: bool
    observed_hash: str | None
    expected_hash: str | None = Field(
        description="null only for the first reset of a seed with no declared hash"
    )


class SeedTargetProgress(BaseModel):
    phase: SeedPhase
    status: SeedPhaseStatus


class SeedAssertionResult(BaseModel):
    outcome: Literal["matched", "mismatch", "unverified", "failed"] = Field(
        description="unverified when the bundle has no seed material or the state cannot be "
        "checked, never reported as matched; failed when a requested reset or the check itself "
        "broke"
    )
    seed_hash: str | None = Field(
        description="hash to pin in config_snapshot.seed_hash; null when unverified"
    )
    observed_hash: str | None
    expected_hash: str | None
    reason: str | None = Field(
        description="run.status_changed.reason: seed_unverified, or the mismatch description"
    )


class RunOracleInput(BaseModel):
    oracle_result_id: UUID


class RunOracleResult(BaseModel):
    status: OracleResultStatus


class LoadSeedMaterialInput(BaseModel):
    seed_id: UUID


class LoadSeedMaterialResult(BaseModel):
    reset_script_ref: str | None = Field(
        description="reference to the reset script, resolved inside the activity; null when absent"
    )
    hash_command_ref: str | None = Field(
        description="reference to the hash command, resolved inside the activity; null when absent"
    )
    script_timeout_seconds: int = Field(
        ge=1,
        description="TESSA_SEED_SCRIPT_TIMEOUT_SECONDS; the workflow sizes the script "
        "activity timeouts from it because the sandbox cannot read settings",
    )


class ExecuteResetScriptInput(BaseModel):
    run_id: UUID
    seed_id: UUID


class ExecuteResetScriptResult(BaseModel):
    exit_code: int
    output_excerpt: str = Field(description="redacted output, at most 4 KB")


class RunHashCommandInput(BaseModel):
    seed_id: UUID


class RunHashCommandResult(BaseModel):
    observed_hash: str


class ExecuteOracleQueryInput(BaseModel):
    oracle_result_id: UUID


class ExecuteOracleQueryResult(BaseModel):
    status: OracleResultStatus = Field(description="ok, or error with the redacted error text")
    row_count: int = Field(
        ge=0,
        description="rows stored in oracle_results.rows; the rows never travel in the payload",
    )
    rows_truncated: bool
    duration_ms: int = Field(ge=0)
    error: str | None


class RenderExpectedSentenceInput(BaseModel):
    oracle_result_id: UUID


class RenderExpectedSentenceResult(BaseModel):
    sentence: str | None = Field(description="null when rendering failed")
    error: str | None


class ResolveGoldPointsInput(BaseModel):
    run_scenario_id: UUID
    attempt: int = Field(ge=0)
    step_index: int = Field(ge=0)


class ResolveGoldPointsResult(BaseModel):
    gold_points: list[GoldPoint]
    blocked: Verdict | None = Field(
        default=None,
        description="set when the gold points could not be produced: the verdict the attempt "
        "must record instead of running the step (skipped for an unapproved oracle, uncertain "
        "for an oracle error)",
    )


class CheckDbExpectationInput(BaseModel):
    step_id: UUID


class CheckDbExpectationResult(BaseModel):
    db_checks: list[DbCheck]
    verdict: Verdict | None = Field(
        default=None,
        description="verdict of the database checks; null when the step has no expect_db",
    )


class ResolveClockInput(BaseModel):
    target_id: UUID
    bundle_id: UUID | None = Field(
        default=None,
        description="bundle the run was created from; absent uses the latest valid bundle of "
        "the target",
    )


ResolveClockResult = ClockSnapshot


class GradeStepInput(BaseModel):
    step_id: UUID
    run_id: UUID
    policy: GradePolicy


class GradeStepResult(BaseModel):
    verdict: Verdict
    escalated_to: VerdictTier | None = Field(
        description="highest tier the step was escalated to; null when code decided alone"
    )
    spent_usd: float = Field(ge=0, description="model spend the RunScenario charges to the ledger")


class RunLayaProbesInput(BaseModel):
    step_id: UUID
    probe_ids: list[str] = Field(description="probes to run; empty selects by invariants")


RunLayaProbesResult = ProbeBatchResult
JudgeTiebreakInput = JudgeStepInput
JudgeTiebreakOutput = JudgeStepOutput


class StoreWeakLabelInput(BaseModel):
    judge_result_id: UUID


class StoreWeakLabelResult(BaseModel):
    label_id: UUID


class EvaluateInvariantsInput(BaseModel):
    run_id: UUID
    run_scenario_id: UUID
    attempt: int | None = Field(
        ge=0, description="attempt to evaluate; null for run-level evaluation of a scenario"
    )
    pack_ids: list[InvariantPack] = Field(
        description="packs whose invariants apply: pack defaults for the app kind, the feature "
        "invariants and the target pack from the bundle"
    )


class InvariantResultBatch(BaseModel):
    results: list[InvariantResult]


class EnsureInvariantScenariosInput(BaseModel):
    run_id: UUID


class InvariantScenarioSkip(BaseModel):
    invariant_id: str
    role: str | None
    interface_id: str | None
    skip_reason: SkipReason


class EnsureInvariantScenariosResult(BaseModel):
    scenario_ids: list[UUID] = Field(description="synthetic invariant scenarios of the run")
    created: int = Field(ge=0)
    reused: int = Field(ge=0)
    skipped: list[InvariantScenarioSkip]


class FindingCandidate(BaseModel):
    fingerprint: str
    finding_class: FindingClass
    severity: Severity
    title: str
    invariant_id: str | None
    scenario_id: UUID | None
    run_scenario_id: UUID | None
    step_id: UUID | None
    attempt: int | None = Field(ge=0)
    feature_id: str | None
    interface_id: str | None
    role: str | None
    family: str | None
    signal: str = Field(description="normalised failing signal the fingerprint was built from")
    embedding_text: str = Field(
        max_length=EMBED_MAX_TEXT_CHARS, description="title and signal, the text that is embedded"
    )
    evidence: dict[str, JsonValue] = Field(description="short redacted facts for the occurrence")
    expected: JsonValue
    actual: JsonValue
    embedding: list[float] | None = Field(
        default=None,
        max_length=EMBEDDING_DIMENSIONS,
        description="set once embed_texts ran; batches of FINDING_TRIAGE_BATCH_SIZE candidates "
        "keep the payload under 256 KB",
    )


class FingerprintFindingsInput(BaseModel):
    run_id: UUID


class FingerprintFindingsResult(BaseModel):
    candidates: list[FindingCandidate]


class EmbedTextsInput(BaseModel):
    run_id: UUID | None = Field(description="run whose ledger is charged; null outside a run")
    texts: list[str] = Field(
        min_length=1,
        max_length=EMBED_MAX_TEXTS_PER_CALL,
        description="texts to embed; the batch is capped so the vectors fit a Temporal payload",
    )
    spec: EmbedCallSpec


class EmbedTextsOutput(ModelUsage):
    vectors: list[list[float]] = Field(
        description="one vector per text in order, each of spec.dimensions floats"
    )


class DedupeMatch(BaseModel):
    fingerprint: str
    kind: Literal["exact", "semantic", "uncertain", "new"] = Field(
        description="exact fingerprint, a semantic duplicate Laya confirmed, a close pair Laya "
        "could not decide (a new finding is created), or no match"
    )
    finding_id: UUID | None = Field(description="the finding to attach to; null for new")
    similarity: float | None = Field(description="cosine similarity of a semantic match")
    possible_duplicate_of: UUID | None = Field(
        description="set for uncertain: recorded in the occurrence evidence"
    )


class DedupeFindingsInput(BaseModel):
    run_id: UUID
    candidates: list[FindingCandidate] = Field(max_length=FINDING_TRIAGE_BATCH_SIZE)
    dedupe_mode: DedupeMode = Field(
        description="exact_only skips the embedding neighbour search and the Laya choice"
    )


class DedupeFindingsResult(BaseModel):
    matches: list[DedupeMatch]


class UpsertDecision(BaseModel):
    candidate: FindingCandidate
    match: DedupeMatch


class UpsertFindingsInput(BaseModel):
    run_id: UUID
    decisions: list[UpsertDecision] = Field(max_length=FINDING_TRIAGE_BATCH_SIZE)


class UpsertFindingsResult(BaseModel):
    created: int = Field(ge=0)
    updated: int = Field(ge=0)
    occurrences_added: int = Field(ge=0)
    known_gap_hits: int = Field(ge=0)
    created_finding_ids: list[UUID] = Field(description="findings that need a repro bundle")


class BuildReproBundleInput(BaseModel):
    finding_id: UUID
    occurrence_id: UUID | None = Field(
        default=None, description="occurrence to build from; absent uses the latest"
    )


class BuildReproBundleResult(BaseModel):
    finding_id: UUID
    stored: bool = Field(description="true when findings.repro was written")
    size_bytes: int = Field(
        ge=0,
        description="size of the stored document; the repro itself never travels through "
        "Temporal because of the 256 KB payload rule",
    )


class TriageFindingsInput(BaseModel):
    run_id: UUID


class TriageFindingsResult(BaseModel):
    created: int = Field(ge=0)
    updated: int = Field(ge=0)
    occurrences_added: int = Field(ge=0)
    known_gap_hits: int = Field(ge=0)
    dedupe_mode: DedupeMode = Field(
        description="exact_only when embeddings failed and only the fingerprint was used"
    )


class ResolveModelSpecsResult(BaseModel):
    judge: ModelCallSpec
    judge_tiebreak: ModelCallSpec
    embed: EmbedCallSpec


RecordModelCallInput = ModelCallRecord


class RecordModelCallResult(BaseModel):
    id: UUID = Field(description="model_calls row written or already present")


class DryRunScenarioInput(BaseModel):
    run_id: UUID = Field(description="generate run that records the dry runs")
    scenario_id: UUID


class DryRunScenarioResult(BaseModel):
    passed_twice: bool
    run_scenario_ids: list[UUID]


class ImportAuthoredScenariosInput(BaseModel):
    bundle_id: UUID


class ImportAuthoredScenariosResult(BaseModel):
    imported: int = Field(ge=0)
    rejected: int = Field(ge=0)
    scenario_ids: list[UUID] = Field(description="imported or version-bumped scenarios")


class RunSchemathesisInput(BaseModel):
    run_id: UUID
    run_scenario_id: UUID = Field(description="synthetic api_fuzz scenario of the role")
    role: str
    openapi_ref: str = Field(description="bundle file path of openapi.json, resolved in the worker")


class FuzzFailure(BaseModel):
    operation: str = Field(description="HTTP method and path template")
    check: str = Field(description="Schemathesis check that failed")
    message: str = Field(description="redacted failure description")
    status_code: int | None
    case_seed: int | None = Field(description="seed that replays the failing case")


class RunSchemathesisResult(BaseModel):
    cases_run: int = Field(ge=0)
    failures: list[FuzzFailure]
    skip_reason: SkipReason | None = Field(
        default=None, description="set when the role could not be fuzzed at all"
    )
    detail: str | None = Field(
        default=None,
        description="why the role was skipped or why the run ended early; never a secret",
    )


class FuzzFamilyInput(BaseModel):
    run_id: UUID


class FuzzFamilyResult(BaseModel):
    roles_total: int = Field(ge=0)
    cases_run: int = Field(ge=0)
    failures_total: int = Field(ge=0)
    notice: str | None = Field(
        default=None, description="why the family could not run at all, shown in the run reason"
    )


class PrepareFuzzFamilyInput(BaseModel):
    run_id: UUID


class FuzzRoleTarget(BaseModel):
    role: str
    interface_id: str
    run_scenario_id: UUID = Field(description="synthetic api_fuzz run scenario of the role")


class PrepareFuzzFamilyResult(BaseModel):
    roles: list[FuzzRoleTarget] = Field(description="roles that are ready to be fuzzed")
    openapi_ref: str | None
    timeout_seconds: int = Field(ge=1, description="fuzz time limit of one role")
    notice: str | None = Field(description="why nothing can be fuzzed; null when something can")


class AgentGoal(BaseModel):
    statement: str = Field(min_length=1, max_length=GOAL_STATEMENT_MAX_LENGTH)
    kind: GoalKind
    success_criteria: list[str] = Field(
        default_factory=list,
        max_length=CRITERIA_MAX_COUNT,
        description="criteria with their typed prefix; only code and the judge see them, never "
        "the persona that plays the user",
    )


class GetWorkerTaskQueueResult(BaseModel):
    task_queue: str = Field(
        min_length=1,
        description="per-worker queue on which every activity of one browser session must run",
    )


class OpenBrowserSessionInput(BaseModel):
    run_id: UUID
    role: str = Field(min_length=1, max_length=GOAL_ROLE_MAX_LENGTH)
    goal: AgentGoal | None = Field(
        default=None,
        description="goal the session pursues; its kind attempt_forbidden switches the boundary "
        "detector on, absent runs the session without detectors",
    )


class OpenBrowserSessionResult(BaseModel):
    browser_session_id: UUID
    run_scenario_id: UUID = Field(
        description="run scenario of the synthetic scenario that owns the steps of the session"
    )
    snapshot_ref: str = Field(min_length=1, description="snapshot of the page after sign in")


class CloseBrowserSessionInput(BaseModel):
    browser_session_id: UUID


class CloseBrowserSessionResult(BaseModel):
    closed: bool = Field(
        description="false when the session was already closed; closing is idempotent"
    )


class ExecuteActionInput(BaseModel):
    browser_session_id: UUID
    action: ExploreAction


class ExecuteActionResult(BaseModel):
    step_id: UUID | None = Field(
        description="step recorded for the action; null when the guard rejected it"
    )
    snapshot_ref: str = Field(
        min_length=1, description="snapshot after the action, or the unchanged one when rejected"
    )
    snapshot_hash: str = Field(
        min_length=1,
        description="hash the workflow compares to detect a page that stopped changing",
    )
    rejected_reason: str | None = Field(
        description="why the action guard refused the action; null when it was executed"
    )
    candidate_ids: list[UUID] = Field(
        description="candidates the detectors or a finish claim created for this action"
    )
    step_index: int | None = Field(
        default=None,
        ge=0,
        description="index of the recorded step; null when the guard rejected the action or the "
        "action was a finish",
    )
    page_url: str | None = Field(
        default=None, description="address of the page after the action, redacted"
    )
    failure: str | None = Field(
        default=None,
        description="why an executed action did not complete (element missing, timeout); null "
        "when it completed",
    )


class VerifyByReplayInput(BaseModel):
    run_id: UUID
    candidate_id: UUID
    goal: AgentGoal | None = Field(
        default=None,
        description="goal of the exploration; the finding of a verified candidate is classified "
        "and described from it",
    )


class VerifyByReplayResult(BaseModel):
    verified: bool = Field(
        description="true when every required replay in a fresh session reproduced the candidate"
    )
    run_scenario_id: UUID | None = Field(
        description="run scenario of the replays; null when they could not start"
    )
    finding_id: UUID | None = Field(
        description="finding created or matched for a verified candidate"
    )


class SendTargetTurnInput(BaseModel):
    run_id: UUID
    sim_session_id: UUID
    role: str = Field(min_length=1, max_length=GOAL_ROLE_MAX_LENGTH)
    text: str = Field(min_length=1, max_length=SIM_TURN_TEXT_MAX_CHARS)


class SendTargetTurnResult(BaseModel):
    reply_text: str = Field(description="reply of the target, redacted")
    step_id: UUID


class CheckSimulationInput(BaseModel):
    sim_session_id: UUID


class CheckSimulationResult(ModelUsage):
    checks: SimChecks
    verdict: Verdict


class SkepticEvidence(BaseModel):
    family: FamilyId
    attack_prompt: str = Field(max_length=SKEPTIC_TEXT_MAX_CHARS)
    target_response: str = Field(
        max_length=SKEPTIC_TEXT_MAX_CHARS, description="response under test, fenced as data"
    )
    breach_signal: str = Field(
        max_length=SKEPTIC_TEXT_MAX_CHARS,
        description="what code and the probes saw that made the attack a candidate",
    )


class SkepticVerifyInput(BaseModel):
    run_id: UUID = Field(description="run whose ledger is charged")
    attack_id: UUID
    evidence: SkepticEvidence
    spec: ModelCallSpec


class SkepticVerifyOutput(ModelUsage):
    verdict: Verdict = Field(description="uncertain is never a confirmation")


class MutationRunInput(BaseModel):
    run_id: UUID = Field(description="run row of kind mutation that carries the events")
    mutation_run_id: UUID = Field(
        description="mutation_runs row the API created together with the run row"
    )
    mutant_id: UUID
    plan_id: UUID
    base_url_override: str | None = Field(
        default=None,
        description="address of the mutant for this run; absent uses the mutant base_url",
    )


class MutationRunResult(BaseModel):
    outcomes: list[MutationOutcomeItem]
    power: Probability | None = Field(
        description="killed catchers divided by killed plus survived; null when none decided"
    )


class MutationRunProgress(BaseModel):
    stage: Literal["verifying_marker", "baseline", "mutant_run", "scoring", "done"]
    baseline_run_id: UUID | None = Field(
        description="suite run the kill rule subtracts; null until it is chosen"
    )
    mutant_run_id: UUID | None = Field(
        description="suite run against the mutant; null until it starts"
    )


class ScoreMutationInput(BaseModel):
    mutation_run_id: UUID
    aborted_reason: str | None = Field(
        default=None,
        max_length=500,
        description="set when the run against the mutant did not complete (marker mismatch, a "
        "failed baseline, a failed or exhausted run): every outcome is then errored",
    )


class ScoreMutationResult(BaseModel):
    outcomes: list[MutationOutcomeItem]
    power: Probability | None
    mutant_outcome: MutationOutcome = Field(
        default=MutationOutcome.errored,
        description="killed on any new failure against the baseline, survived when an expected "
        "catcher decided and none failed, errored or skipped otherwise",
    )


class ScheduledRunInput(BaseModel):
    schedule_id: UUID
    run_id: UUID | None = Field(
        default=None,
        description="run row the API already created for run-now; absent lets the workflow "
        "create it",
    )


class ScheduledRunResult(BaseModel):
    run_id: UUID | None = Field(
        default=None, description="null when the API refused the run before a run row existed"
    )
    status: RunStatus | None = Field(default=None, description="null when the run was refused")
    counters: RunCounters | None = Field(
        default=None,
        description="pass, fail, flaky, uncertain and skipped stay separate: uncertain is never "
        "folded into pass or fail; null when the run was refused",
    )


class ApplyFlakinessPolicyInput(BaseModel):
    run_id: UUID


class ApplyFlakinessPolicyResult(BaseModel):
    quarantined: list[UUID] = Field(description="scenario ids this call quarantined")
    findings: list[UUID] = Field(description="finding ids of the flaky findings it filed")


class RenderReportInput(BaseModel):
    run_id: UUID


class RenderReportResult(BaseModel):
    json_path: str = Field(description="report.json path relative to TESSA_DATA_DIR")
    html_path: str = Field(description="report.html path relative to TESSA_DATA_DIR")


class BuildReportInput(BaseModel):
    run_id: UUID
    channels: list[ReportChannel] = Field(
        default_factory=list, description="channels to announce the finished run on"
    )


class BuildReportResult(BaseModel):
    json_ref: str = Field(description="report.json path relative to TESSA_DATA_DIR")
    html_ref: str = Field(description="report.html path relative to TESSA_DATA_DIR")
    sent: list[ReportChannel] = Field(description="channels that accepted the message")


class SlackMessage(BaseModel):
    webhook_ref: SecretName = Field(
        description="name of the secret that holds the webhook; the activity resolves it at call "
        "time and the URL never enters Temporal"
    )
    text: str = Field(min_length=1, max_length=SLACK_TEXT_MAX_CHARS)
    link: str | None = Field(
        default=None,
        max_length=SLACK_LINK_MAX_CHARS,
        description="absolute report link built from TESSA_REPORT_BASE_URL; links are only "
        "absolute inside Slack and email text",
    )

    @field_validator("webhook_ref")
    @classmethod
    def webhook_ref_names_the_slack_secret(cls, value: SecretName) -> SecretName:
        if value is not SecretName.slack_webhook_url:
            raise ValueError("webhook_ref must be slack_webhook_url")
        return value


class ChannelSendResult(BaseModel):
    ok: bool


CreateNotificationInput = NotificationContent


class CreateNotificationResult(BaseModel):
    notification_id: UUID = Field(description="notification written or already present")
    created: bool = Field(
        description="false when the unique (kind, run_id) notification already existed, so the "
        "caller does not send it again"
    )


class RetentionSweepInput(BaseModel):
    pass


class RetentionSweepOutput(RetentionSweepCounts):
    pass
