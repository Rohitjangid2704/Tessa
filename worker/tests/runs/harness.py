import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
from temporalio import activity
from temporalio.client import WorkflowHandle
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    Effort,
    ModelCallRole,
    ModelCallStatus,
    RunScenarioStatus,
    RunStatus,
    SeedAction,
    SeedHashSource,
)
from tessa_api.schemas.model_calls import ModelCallRecord
from tessa_api.schemas.runs import ClockSnapshot
from tessa_api.schemas.scenarios import ScenarioValidation
from tessa_api.schemas.temporal import (
    APPLY_FLAKINESS_POLICY_ACTIVITY,
    CREATE_RUN_SCENARIOS_ACTIVITY,
    DRIVE_SCENARIO_ATTEMPT_ACTIVITY,
    ENSURE_INVARIANT_SCENARIOS_ACTIVITY,
    EVALUATE_INVARIANTS_ACTIVITY,
    EXECUTE_RUN_WORKFLOW,
    EXPAND_CELLS_ACTIVITY,
    FINGERPRINT_FINDINGS_ACTIVITY,
    GENERATE_SMOKE_SCENARIO_ACTIVITY,
    LOAD_SEED_MATERIAL_ACTIVITY,
    PREPARE_FUZZ_FAMILY_ACTIVITY,
    RENDER_REPORT_ACTIVITY,
    RUN_HASH_COMMAND_ACTIVITY,
    VALIDATE_SCENARIO_ACTIVITY,
    ApplyFlakinessPolicyInput,
    ApplyFlakinessPolicyResult,
    AttemptResult,
    CreateRunScenariosInput,
    CreateRunScenariosResult,
    DriveAttemptInput,
    EnsureInvariantScenariosInput,
    EnsureInvariantScenariosResult,
    EvaluateInvariantsInput,
    ExecuteRunInput,
    ExecuteRunResult,
    ExpandCellsInput,
    ExpandCellsResult,
    FingerprintFindingsInput,
    FingerprintFindingsResult,
    GenerateSmokeScenarioInput,
    InvariantResultBatch,
    LoadSeedMaterialInput,
    LoadSeedMaterialResult,
    PrepareFuzzFamilyInput,
    PrepareFuzzFamilyResult,
    RenderReportInput,
    RenderReportResult,
    RunHashCommandInput,
    RunHashCommandResult,
    SeedAssertionResult,
    ValidateScenarioInput,
    execute_run_workflow_id,
)
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.events import EventActivities
from tessa_worker.activities.findings_models import (
    RESOLVE_FINDINGS,
    ResolveFindingsInput,
    ResolveFindingsResult,
)
from tessa_worker.activities.grading import GradingActivities
from tessa_worker.activities.model_call import DatabaseModelCallRecorder
from tessa_worker.activities.names import (
    ASSERT_SEED,
    BEGIN_SCENARIO_ATTEMPT,
    FREEZE_RUN_CONFIG,
    OPEN_SEED_RUN,
    PLAN_SEED_ASSERTION,
    RECORD_SEED_OUTCOME,
)
from tessa_worker.activities.notify_models import (
    EVALUATE_NOTIFICATIONS,
    EvaluateNotificationsInput,
    EvaluateNotificationsResult,
)
from tessa_worker.activities.run_context import RunContextActivities
from tessa_worker.activities.run_models import (
    AssertSeedInput,
    BeginScenarioAttemptInput,
    FreezeRunConfigInput,
    FreezeRunConfigResult,
    GenerateSmokeScenarioOutcome,
    SeedAssertionPlan,
    SettleSeedAssertionInput,
)
from tessa_worker.activities.run_status import RunStatusActivities
from tessa_worker.activities.scenario_lifecycle import ScenarioLifecycleActivities
from tessa_worker.activities.seeding_models import (
    OpenSeedRunInput,
    OpenSeedRunResult,
    RecordSeedOutcomeInput,
    RecordSeedOutcomeResult,
)
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings
from tessa_worker.verdicts import pass_verdict
from tessa_worker.workflows import WORKFLOWS
from tests.runs.support import FAST_DELIVERY, RecordingIngest, SeededRun, load_run

TASK_QUEUE = "tessa-test-worker-runs"
HEARTBEAT_THROTTLE = timedelta(milliseconds=100)
POLL_SECONDS = 0.02
POLL_ATTEMPTS = 1000
FROZEN_AT = datetime(2026, 10, 14, 9, 0, 0, tzinfo=UTC)
SCRIPTED_SEED_ID = UUID(int=7)
SCRIPTED_HASH = "scripted-hash"

DriveScript = Callable[[DriveAttemptInput], Awaitable[AttemptResult]]


def attempt_result(
    verdict: Verdict | None = None,
    cost_usd: float = 0.0,
    steps_recorded: int = 1,
    status: RunScenarioStatus = RunScenarioStatus.finished,
) -> AttemptResult:
    return AttemptResult(
        status=status,
        steps_recorded=steps_recorded,
        cost_usd=cost_usd,
        browser_session_id=None,
        verdict=verdict if verdict is not None else pass_verdict(),
        error=None,
    )


async def passing(request: DriveAttemptInput) -> AttemptResult:
    return attempt_result()


async def heartbeat_until_cancelled() -> None:
    while True:
        activity.heartbeat()
        await asyncio.sleep(0.02)


def ledger_charge(
    session_factory: SessionFactory, cost_usd: float
) -> Callable[[DriveAttemptInput], Awaitable[None]]:
    recorder = DatabaseModelCallRecorder(session_factory)

    async def charge(request: DriveAttemptInput) -> None:
        await recorder.record(
            ModelCallRecord(
                id=uuid4(),
                run_id=request.run_id,
                step_id=None,
                role=ModelCallRole.judge,
                activity="judge_step",
                model="judge-test",
                effort=Effort.low,
                latency_ms=1,
                status=ModelCallStatus.ok,
                cost_usd=cost_usd,
                input_tokens=1,
                output_tokens=1,
            )
        )

    return charge


@dataclass
class ScriptedDrive:
    script: DriveScript = passing
    calls: list[DriveAttemptInput] = field(default_factory=list)
    active: int = 0
    peak: int = 0
    cancelled: list[UUID] = field(default_factory=list)

    @activity.defn(name=DRIVE_SCENARIO_ATTEMPT_ACTIVITY)
    async def drive_scenario_attempt(self, request: DriveAttemptInput) -> AttemptResult:
        self.calls.append(request)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            return await self.script(request)
        except asyncio.CancelledError:
            self.cancelled.append(request.run_scenario_id)
            raise
        finally:
            self.active -= 1


@dataclass
class StubPlanning:
    cell_ids: list[UUID] = field(default_factory=list)
    scenario_ids_per_cell: int = 1
    invalid_scenario_ids: set[UUID] = field(default_factory=set)
    seeded: SeededRun | None = None
    generate_failure: Exception | None = None
    reused_cells: set[UUID] = field(default_factory=set)
    expanded_for: list[UUID] = field(default_factory=list)
    created_for: list[UUID] = field(default_factory=list)
    generated: list[UUID] = field(default_factory=list)
    validated: list[UUID] = field(default_factory=list)

    @activity.defn(name=EXPAND_CELLS_ACTIVITY)
    async def expand_cells(self, request: ExpandCellsInput) -> ExpandCellsResult:
        self.expanded_for.append(request.plan_id)
        return ExpandCellsResult(cell_ids=list(self.cell_ids))

    @activity.defn(name=GENERATE_SMOKE_SCENARIO_ACTIVITY)
    async def generate_smoke_scenario(
        self, request: GenerateSmokeScenarioInput
    ) -> GenerateSmokeScenarioOutcome:
        self.generated.append(request.cell_id)
        if self.generate_failure is not None:
            raise self.generate_failure
        scenario_ids = [
            UUID(int=request.cell_id.int + offset + 1)
            for offset in range(self.scenario_ids_per_cell)
        ]
        reused = len(scenario_ids) if request.cell_id in self.reused_cells else 0
        return GenerateSmokeScenarioOutcome(
            scenario_ids=scenario_ids, created=len(scenario_ids) - reused, reused=reused
        )

    @activity.defn(name=VALIDATE_SCENARIO_ACTIVITY)
    async def validate_scenario(self, request: ValidateScenarioInput) -> ScenarioValidation:
        self.validated.append(request.scenario_id)
        valid = request.scenario_id not in self.invalid_scenario_ids
        return ScenarioValidation(valid=valid, errors=[], warnings=[])

    @activity.defn(name=CREATE_RUN_SCENARIOS_ACTIVITY)
    async def create_run_scenarios(
        self, request: CreateRunScenariosInput
    ) -> CreateRunScenariosResult:
        self.created_for.append(request.run_id)
        ids = [] if self.seeded is None else list(self.seeded.run_scenario_ids)
        return CreateRunScenariosResult(run_scenario_ids=ids)


class FailingLifecycle(ScenarioLifecycleActivities):
    def __init__(
        self, session_factory: SessionFactory, events: EventClient, failing: set[UUID]
    ) -> None:
        super().__init__(session_factory, events)
        self.failing = failing

    @activity.defn(name=BEGIN_SCENARIO_ATTEMPT)
    async def begin_scenario_attempt(self, request: BeginScenarioAttemptInput) -> None:
        if request.run_scenario_id in self.failing:
            raise ApplicationError(
                "the scenario row is locked by a failing test", non_retryable=True
            )
        await super().begin_scenario_attempt(request)


def unverified_result() -> SeedAssertionResult:
    return SeedAssertionResult(
        outcome="unverified",
        seed_hash=None,
        observed_hash=None,
        expected_hash=None,
        reason="seed_unverified",
    )


@dataclass
class ScriptedSeedGate:
    result: SeedAssertionResult = field(default_factory=unverified_result)
    calls: list[UUID] = field(default_factory=list)
    settled: list[SettleSeedAssertionInput] = field(default_factory=list)

    @activity.defn(name=PLAN_SEED_ASSERTION)
    async def plan_seed_assertion(self, request: AssertSeedInput) -> SeedAssertionPlan:
        self.calls.append(request.run_id)
        if self.result.outcome == "unverified":
            return SeedAssertionPlan(unverified_reason=self.result.reason)
        if self.result.outcome == "failed":
            return SeedAssertionPlan(failure_reason=self.result.reason)
        return SeedAssertionPlan(
            target_id=request.run_id, seed_id=SCRIPTED_SEED_ID, action=SeedAction.verify
        )

    @activity.defn(name=ASSERT_SEED)
    async def assert_seed(self, request: SettleSeedAssertionInput) -> SeedAssertionResult:
        self.settled.append(request)
        return self.result

    @activity.defn(name=OPEN_SEED_RUN)
    async def open_seed_run(self, request: OpenSeedRunInput) -> OpenSeedRunResult:
        return OpenSeedRunResult(
            owns_run=False,
            declared_hash=self.result.expected_hash or SCRIPTED_HASH,
            hash_source=SeedHashSource.bundle,
        )

    @activity.defn(name=LOAD_SEED_MATERIAL_ACTIVITY)
    async def load_seed_material(self, request: LoadSeedMaterialInput) -> LoadSeedMaterialResult:
        return LoadSeedMaterialResult(
            reset_script_ref=None,
            hash_command_ref=f"seed:{request.seed_id}:hash_command",
            script_timeout_seconds=30,
        )

    @activity.defn(name=RUN_HASH_COMMAND_ACTIVITY)
    async def run_hash_command(self, request: RunHashCommandInput) -> RunHashCommandResult:
        return RunHashCommandResult(observed_hash=self.result.observed_hash or SCRIPTED_HASH)

    @activity.defn(name=RECORD_SEED_OUTCOME)
    async def record_seed_outcome(self, request: RecordSeedOutcomeInput) -> RecordSeedOutcomeResult:
        return RecordSeedOutcomeResult(
            declared_hash=self.result.expected_hash, hash_source=SeedHashSource.bundle
        )

    def activities(self) -> list[Callable[..., Any]]:
        return [
            self.plan_seed_assertion,
            self.assert_seed,
            self.open_seed_run,
            self.load_seed_material,
            self.run_hash_command,
            self.record_seed_outcome,
        ]


@dataclass
class ScriptedLoop:
    invariant_batch: InvariantResultBatch = field(
        default_factory=lambda: InvariantResultBatch(results=[])
    )
    fuzz_notice: str = "no OpenAPI document in the bundle"
    frozen: list[UUID] = field(default_factory=list)
    invariant_scenarios_for: list[UUID] = field(default_factory=list)
    evaluated: list[EvaluateInvariantsInput] = field(default_factory=list)
    triaged: list[UUID] = field(default_factory=list)
    resolved: list[UUID] = field(default_factory=list)
    flakiness: list[UUID] = field(default_factory=list)
    reported: list[UUID] = field(default_factory=list)
    notified: list[UUID] = field(default_factory=list)
    fuzzed: list[UUID] = field(default_factory=list)

    @activity.defn(name=FREEZE_RUN_CONFIG)
    async def freeze_run_config(self, request: FreezeRunConfigInput) -> FreezeRunConfigResult:
        self.frozen.append(request.run_id)
        return FreezeRunConfigResult(
            clock=ClockSnapshot(mode="real", at=FROZEN_AT), models={}, probe_bank_version="test"
        )

    @activity.defn(name=ENSURE_INVARIANT_SCENARIOS_ACTIVITY)
    async def ensure_invariant_scenarios(
        self, request: EnsureInvariantScenariosInput
    ) -> EnsureInvariantScenariosResult:
        self.invariant_scenarios_for.append(request.run_id)
        return EnsureInvariantScenariosResult(scenario_ids=[], created=0, reused=0, skipped=[])

    @activity.defn(name=EVALUATE_INVARIANTS_ACTIVITY)
    async def evaluate_invariants(self, request: EvaluateInvariantsInput) -> InvariantResultBatch:
        self.evaluated.append(request)
        return self.invariant_batch

    @activity.defn(name=FINGERPRINT_FINDINGS_ACTIVITY)
    async def fingerprint_findings(
        self, request: FingerprintFindingsInput
    ) -> FingerprintFindingsResult:
        self.triaged.append(request.run_id)
        return FingerprintFindingsResult(candidates=[])

    @activity.defn(name=RESOLVE_FINDINGS)
    async def resolve_findings(self, request: ResolveFindingsInput) -> ResolveFindingsResult:
        self.resolved.append(request.run_id)
        return ResolveFindingsResult(resolved_finding_ids=[])

    @activity.defn(name=APPLY_FLAKINESS_POLICY_ACTIVITY)
    async def apply_flakiness_policy(
        self, request: ApplyFlakinessPolicyInput
    ) -> ApplyFlakinessPolicyResult:
        self.flakiness.append(request.run_id)
        return ApplyFlakinessPolicyResult(quarantined=[], findings=[])

    @activity.defn(name=RENDER_REPORT_ACTIVITY)
    async def render_report(self, request: RenderReportInput) -> RenderReportResult:
        self.reported.append(request.run_id)
        return RenderReportResult(json_path="report.json", html_path="report.html")

    @activity.defn(name=EVALUATE_NOTIFICATIONS)
    async def evaluate_notifications(
        self, request: EvaluateNotificationsInput
    ) -> EvaluateNotificationsResult:
        self.notified.append(request.run_id)
        return EvaluateNotificationsResult(notifications=[])

    @activity.defn(name=PREPARE_FUZZ_FAMILY_ACTIVITY)
    async def prepare_fuzz_family(self, request: PrepareFuzzFamilyInput) -> PrepareFuzzFamilyResult:
        self.fuzzed.append(request.run_id)
        return PrepareFuzzFamilyResult(
            roles=[], openapi_ref=None, timeout_seconds=60, notice=self.fuzz_notice
        )

    def activities(self) -> list[Callable[..., Any]]:
        return [
            self.freeze_run_config,
            self.ensure_invariant_scenarios,
            self.evaluate_invariants,
            self.fingerprint_findings,
            self.resolve_findings,
            self.apply_flakiness_policy,
            self.render_report,
            self.evaluate_notifications,
            self.prepare_fuzz_family,
        ]


@dataclass
class RunStack:
    environment: WorkflowEnvironment
    session_factory: SessionFactory
    ingest: RecordingIngest
    drive: ScriptedDrive
    planning: StubPlanning
    loop: ScriptedLoop

    async def start(
        self, run_id: UUID, reset_seed: bool = False, owns_run: bool = True
    ) -> WorkflowHandle[Any, ExecuteRunResult]:
        return await self.environment.client.start_workflow(
            EXECUTE_RUN_WORKFLOW,
            ExecuteRunInput(run_id=run_id, reset_seed=reset_seed, owns_run=owns_run),
            id=execute_run_workflow_id(run_id),
            task_queue=TASK_QUEUE,
            result_type=ExecuteRunResult,
        )

    async def run(
        self, run_id: UUID, reset_seed: bool = False, owns_run: bool = True
    ) -> ExecuteRunResult:
        handle = await self.start(run_id, reset_seed, owns_run)
        return await handle.result()

    async def wait_for_status(self, run_id: UUID, status: RunStatus) -> None:
        async def reached() -> bool:
            return (await load_run(self.session_factory, run_id)).status is status

        await wait_until(reached)


async def wait_until(predicate: Callable[[], Awaitable[bool]]) -> None:
    for _ in range(POLL_ATTEMPTS):
        if await predicate():
            return
        await asyncio.sleep(POLL_SECONDS)
    raise AssertionError("condition did not become true in time")


@asynccontextmanager
async def run_stack(
    environment: WorkflowEnvironment,
    session_factory: SessionFactory,
    settings: WorkerSettings,
    ingest: RecordingIngest,
    drive: ScriptedDrive | None = None,
    planning: StubPlanning | None = None,
    seed_gate: ScriptedSeedGate | None = None,
    failing_scenarios: set[UUID] | None = None,
    loop: ScriptedLoop | None = None,
    seed_activities: Sequence[Callable[..., Any]] | None = None,
) -> AsyncIterator[RunStack]:
    drive = drive or ScriptedDrive()
    planning = planning or StubPlanning()
    loop = loop or ScriptedLoop()
    seeding = (
        list(seed_activities)
        if seed_activities is not None
        else (seed_gate or ScriptedSeedGate()).activities()
    )
    transport = httpx.MockTransport(ingest.handle)
    async with httpx.AsyncClient(transport=transport) as http:
        events = EventClient(settings, http, FAST_DELIVERY)
        grading = GradingActivities(
            settings, session_factory, events, vault_from_settings(settings)
        )
        status = RunStatusActivities(session_factory, events)
        lifecycle = FailingLifecycle(session_factory, events, failing_scenarios or set())
        activities: list[Any] = [
            EventActivities(settings, http).emit_run_event,
            RunContextActivities(session_factory, settings).load_run_context,
            drive.drive_scenario_attempt,
            planning.expand_cells,
            planning.generate_smoke_scenario,
            planning.validate_scenario,
            planning.create_run_scenarios,
            status.update_run_status,
            status.finalize_run,
            status.publish_run_progress,
            lifecycle.begin_scenario_attempt,
            lifecycle.record_scenario_attempt,
            lifecycle.finish_run_scenario,
            lifecycle.skip_run_scenarios,
            lifecycle.skip_ungraded_steps,
            grading.list_attempt_steps,
            grading.resolve_grade_policy,
            grading.record_step_grade,
            *seeding,
            *loop.activities(),
        ]
        async with Worker(
            environment.client,
            task_queue=TASK_QUEUE,
            workflows=WORKFLOWS,
            activities=activities,
            max_heartbeat_throttle_interval=HEARTBEAT_THROTTLE,
            default_heartbeat_throttle_interval=HEARTBEAT_THROTTLE,
        ):
            yield RunStack(environment, session_factory, ingest, drive, planning, loop)
