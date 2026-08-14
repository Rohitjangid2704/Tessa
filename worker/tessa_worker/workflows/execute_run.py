import asyncio
import contextlib
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

from temporalio import workflow
from temporalio.exceptions import ActivityError, ApplicationError, ChildWorkflowError, FailureError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.common import BudgetState
    from tessa_api.schemas.enums import (
        ReportChannel,
        RunScenarioStatus,
        RunStatus,
        ScheduleTier,
        SkipReason,
    )
    from tessa_api.schemas.temporal import (
        BUILD_REPORT_WORKFLOW,
        CANCEL_SIGNAL,
        CREATE_RUN_SCENARIOS_ACTIVITY,
        ENSURE_INVARIANT_SCENARIOS_ACTIVITY,
        EXECUTE_RUN_WORKFLOW,
        FINALIZE_RUN_ACTIVITY,
        LOAD_RUN_CONTEXT_ACTIVITY,
        PLAN_COVERAGE_WORKFLOW,
        PROGRESS_EVENT_MIN_INTERVAL,
        PROGRESS_QUERY,
        RUN_SCENARIO_WORKFLOW,
        TRIAGE_FINDINGS_WORKFLOW,
        UPDATE_RUN_STATUS_ACTIVITY,
        BuildReportInput,
        BuildReportResult,
        CreateRunScenariosInput,
        CreateRunScenariosResult,
        EnsureInvariantScenariosInput,
        EnsureInvariantScenariosResult,
        ExecuteRunInput,
        ExecuteRunProgress,
        ExecuteRunResult,
        FinalizeRunInput,
        FinalizeRunResult,
        LoadRunContextInput,
        PlanCoverageInput,
        PlanCoverageResult,
        RunContext,
        RunScenarioInput,
        RunScenarioRef,
        RunScenarioResult,
        TriageFindingsInput,
        TriageFindingsResult,
        UpdateRunStatusInput,
        UpdateRunStatusResult,
        build_report_workflow_id,
        plan_coverage_workflow_id,
        run_scenario_workflow_id,
        triage_findings_workflow_id,
    )
    from tessa_worker.activities.names import (
        FINISH_RUN_SCENARIO,
        FREEZE_RUN_CONFIG,
        PUBLISH_RUN_PROGRESS,
        SKIP_RUN_SCENARIOS,
        SKIP_UNGRADED_STEPS,
    )
    from tessa_worker.activities.run_models import (
        FinishRunScenarioInput,
        FreezeRunConfigInput,
        FreezeRunConfigResult,
        PublishRunProgressInput,
        PublishRunProgressResult,
        SkipRunScenariosInput,
        SkipRunScenariosResult,
        SkipUngradedStepsInput,
        SkipUngradedStepsResult,
    )
    from tessa_worker.counters import empty_counters
    from tessa_worker.events import emit_event
    from tessa_worker.verdicts import SCENARIO_WORKFLOW_FAILED, uncertain_verdict
    from tessa_worker.workflows.api_fuzz import run_api_fuzz
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_result,
        failure_text,
    )
    from tessa_worker.workflows.ledger import (
        BUDGET_POLL_INTERVAL,
        BudgetDimension,
        BudgetLedger,
    )
    from tessa_worker.workflows.seed_assertion import assert_run_seed

SEED_MISMATCH_REASON = "seed mismatch: the target data differs from the seed"
SEED_FAILED_REASON = "the seed could not be asserted"
FREEZE_RUN_CONFIG_START_TO_CLOSE = timedelta(seconds=90)
ENSURE_INVARIANT_SCENARIOS_START_TO_CLOSE = timedelta(seconds=90)
TRIAGE_EXECUTION_TIMEOUT = timedelta(minutes=10)
REPORT_EXECUTION_TIMEOUT = timedelta(minutes=10)
CANCELED_REASON = "canceled by request"
API_FUZZ_NOT_RUN_NOTICE = "api fuzz was not run because the run was stopped"
OVERSHOOT_NOTE = "overshoot is bounded by the model calls in flight, each at most its role max_usd"
UNSTARTED_BUDGET = BudgetState(max_usd=0.0, spent_usd=0.0, max_minutes=1, elapsed_ms=0)


def joined_reason(*parts: str | None) -> str | None:
    present = [part for part in parts if part]
    return "; ".join(present) if present else None


@dataclass(frozen=True, slots=True)
class StopDecision:
    reason: SkipReason
    dimension: BudgetDimension | None


@workflow.defn(name=EXECUTE_RUN_WORKFLOW)
class ExecuteRunWorkflow:
    def __init__(self) -> None:
        self.cancel_requested = False
        self.stop: StopDecision | None = None
        self.started_ledger: BudgetLedger | None = None
        self.counters = empty_counters()
        self.progress_dirty = False
        self.progress_stopped = False
        self.progress_sequence = 0
        self.tasks: list[asyncio.Task[None]] = []
        self.notices: list[str] = []
        self.active: dict[UUID, workflow.ChildWorkflowHandle[Any, RunScenarioResult]] = {}
        self.commit_tier = False
        self.subset = False
        self.owns_run = True

    @property
    def ledger(self) -> BudgetLedger:
        if self.started_ledger is None:
            raise RuntimeError("the budget ledger exists only after the run context is loaded")
        return self.started_ledger

    @workflow.signal(name=CANCEL_SIGNAL)
    def cancel(self) -> None:
        self.cancel_requested = True

    def is_cancel_requested(self) -> bool:
        return self.cancel_requested

    @workflow.query(name=PROGRESS_QUERY)
    def progress(self) -> ExecuteRunProgress:
        budget = (
            UNSTARTED_BUDGET
            if self.started_ledger is None
            else self.started_ledger.state(workflow.now())
        )
        return ExecuteRunProgress(counters=self.counters, budget=budget)

    @workflow.run
    async def run(self, request: ExecuteRunInput) -> ExecuteRunResult:
        self.owns_run = request.owns_run
        try:
            result = await self.execute(request)
        except asyncio.CancelledError:
            self.cancel_requested = True
            await self.abandon_scenarios(request.run_id)
            await self.conclude(request.run_id, RunStatus.canceled, CANCELED_REASON)
            raise
        except Exception as error:
            await self.conclude(request.run_id, RunStatus.failed, failure_text(error))
            if isinstance(error, FailureError):
                raise
            raise ApplicationError(failure_text(error), non_retryable=True) from error
        await self.build_report(request.run_id)
        return result

    async def build_report(self, run_id: UUID) -> None:
        if not self.owns_run:
            return
        try:
            await workflow.execute_child_workflow(
                BUILD_REPORT_WORKFLOW,
                BuildReportInput(run_id=run_id, channels=list(ReportChannel)),
                id=build_report_workflow_id(run_id),
                result_type=BuildReportResult,
                execution_timeout=REPORT_EXECUTION_TIMEOUT,
            )
        except ChildWorkflowError as error:
            workflow.logger.warning("report_not_built", extra={"cause": failure_text(error)})

    async def execute(self, request: ExecuteRunInput) -> ExecuteRunResult:
        run_id = request.run_id
        context = await self.load_context(run_id)
        self.commit_tier = context.config_snapshot.schedule_tier is ScheduleTier.commit
        self.subset = context.config_snapshot.scenario_ids is not None
        self.started_ledger = BudgetLedger(budget=context.budget, started_at=workflow.now())
        await self.set_status(run_id, RunStatus.planning)
        await self.plan(run_id, context)
        if self.cancel_requested:
            return await self.cancel_before_running(run_id)
        await self.set_status(run_id, RunStatus.seeding)
        seed = await assert_run_seed(run_id, request.reset_seed, self.is_cancel_requested)
        if self.cancel_requested:
            return await self.cancel_before_running(run_id)
        if seed.outcome == "mismatch":
            await self.skip_queued(run_id, SkipReason.seed_mismatch)
            return await self.conclude(
                run_id, RunStatus.failed, seed.reason or SEED_MISMATCH_REASON
            )
        if seed.outcome == "failed":
            await self.skip_queued(run_id, SkipReason.precondition_failed)
            return await self.conclude(run_id, RunStatus.failed, seed.reason or SEED_FAILED_REASON)
        context = await self.load_context(run_id)
        await self.set_status(run_id, RunStatus.running, seed.reason)
        await self.run_scenarios(run_id, context, request.max_concurrency)
        await self.settle_spend(run_id)
        await self.api_fuzz(run_id, context)
        triage_failure = await self.triage_findings(run_id)
        return await self.conclude(
            run_id,
            self.final_status(),
            joined_reason(self.final_reason(), *self.notices, triage_failure),
        )

    async def plan(self, run_id: UUID, context: RunContext) -> None:
        if not self.subset:
            await workflow.execute_child_workflow(
                PLAN_COVERAGE_WORKFLOW,
                PlanCoverageInput(plan_id=context.plan.id, run_id=run_id),
                id=plan_coverage_workflow_id(run_id),
                result_type=PlanCoverageResult,
            )
        if self.cancel_requested:
            return
        await call_activity(
            CREATE_RUN_SCENARIOS_ACTIVITY,
            CreateRunScenariosInput(run_id=run_id),
            CreateRunScenariosResult,
        )
        if not self.commit_tier and not self.subset:
            await self.ensure_invariant_scenarios(run_id)
        await call_activity(
            FREEZE_RUN_CONFIG,
            FreezeRunConfigInput(run_id=run_id),
            FreezeRunConfigResult,
            FREEZE_RUN_CONFIG_START_TO_CLOSE,
        )

    async def load_context(self, run_id: UUID) -> RunContext:
        return await call_activity(
            LOAD_RUN_CONTEXT_ACTIVITY, LoadRunContextInput(run_id=run_id), RunContext
        )

    async def set_status(self, run_id: UUID, status: RunStatus, reason: str | None = None) -> None:
        await call_activity(
            UPDATE_RUN_STATUS_ACTIVITY,
            UpdateRunStatusInput(run_id=run_id, status=status, reason=reason),
            UpdateRunStatusResult,
        )

    async def skip_queued(self, run_id: UUID, reason: SkipReason) -> None:
        await call_activity(
            SKIP_RUN_SCENARIOS,
            SkipRunScenariosInput(run_id=run_id, reason=reason),
            SkipRunScenariosResult,
        )

    async def cancel_before_running(self, run_id: UUID) -> ExecuteRunResult:
        await self.set_status(run_id, RunStatus.canceling)
        await self.skip_queued(run_id, SkipReason.canceled)
        return await self.conclude(run_id, RunStatus.canceled, CANCELED_REASON)

    async def abandon_scenarios(self, run_id: UUID) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.skip_queued(run_id, SkipReason.canceled)

    async def ensure_invariant_scenarios(self, run_id: UUID) -> None:
        try:
            await call_activity(
                ENSURE_INVARIANT_SCENARIOS_ACTIVITY,
                EnsureInvariantScenariosInput(run_id=run_id),
                EnsureInvariantScenariosResult,
                ENSURE_INVARIANT_SCENARIOS_START_TO_CLOSE,
            )
        except ActivityError as error:
            self.notices.append(f"invariant scenarios were not planned: {failure_text(error)}")

    async def settle_spend(self, run_id: UUID) -> None:
        published = await self.publish_progress(run_id)
        if published is None:
            return
        self.ledger.observe(published.spent_usd, published.blocked_calls)
        if self.stop is not None or self.cancel_requested:
            return
        if self.ledger.spent_usd > self.ledger.budget.max_usd:
            self.stop = StopDecision(SkipReason.budget_exceeded, "usd")
            exhausted = self.ledger.exhaustion("usd", workflow.now())
            await emit_event(
                run_id, "budget.exhausted", exhausted.model_dump(mode="json"), "budget.exhausted"
            )

    async def conclude(
        self, run_id: UUID, status: RunStatus, reason: str | None
    ) -> ExecuteRunResult:
        await self.publish_progress(run_id)
        finalized = await call_activity(
            FINALIZE_RUN_ACTIVITY, FinalizeRunInput(run_id=run_id), FinalizeRunResult
        )
        if self.owns_run:
            await self.set_status(run_id, status, reason)
        self.counters = finalized.counters
        return ExecuteRunResult(
            status=status,
            counters=finalized.counters,
            spent_usd=finalized.spent_usd,
            reason=reason,
        )

    def final_status(self) -> RunStatus:
        if self.stop is None:
            return RunStatus.completed
        if self.stop.reason is SkipReason.canceled:
            return RunStatus.canceled
        return RunStatus.budget_exceeded

    def final_reason(self) -> str | None:
        if self.stop is None:
            return None
        if self.stop.reason is SkipReason.canceled:
            return CANCELED_REASON
        exhausted = self.ledger.exhaustion(self.stop.dimension or "minutes", workflow.now())
        reason = f"{exhausted.dimension} budget of {exhausted.limit:g} exhausted"
        if exhausted.dimension == "usd":
            return f"{reason} (spent {exhausted.actual:g}; {OVERSHOOT_NOTE})"
        return reason

    async def api_fuzz(self, run_id: UUID, context: RunContext) -> None:
        if (
            not context.plan.include_api_fuzz
            or self.commit_tier
            or self.subset
            or self.stop_is_cancel()
        ):
            return
        if self.stop is not None:
            self.notices.append(API_FUZZ_NOT_RUN_NOTICE)
            return
        if not self.cancel_requested:
            self.notices.extend(await run_api_fuzz(run_id, self.is_cancel_requested))
        if self.cancel_requested:
            self.stop = StopDecision(SkipReason.canceled, None)
            await self.set_status(run_id, RunStatus.canceling)

    async def triage_findings(self, run_id: UUID) -> str | None:
        if not self.owns_run or self.cancel_requested or self.stop_is_cancel():
            return None
        try:
            await workflow.execute_child_workflow(
                TRIAGE_FINDINGS_WORKFLOW,
                TriageFindingsInput(run_id=run_id),
                id=triage_findings_workflow_id(run_id),
                result_type=TriageFindingsResult,
                execution_timeout=TRIAGE_EXECUTION_TIMEOUT,
            )
        except ChildWorkflowError as error:
            return f"findings triage failed: {failure_text(error)}"
        return None

    def stop_is_cancel(self) -> bool:
        return self.stop is not None and self.stop.reason is SkipReason.canceled

    async def run_scenarios(
        self, run_id: UUID, context: RunContext, requested_concurrency: int | None
    ) -> None:
        slots = asyncio.Semaphore(requested_concurrency or context.max_concurrency)
        self.progress_dirty = True
        self.tasks = [
            asyncio.create_task(self.run_one(run_id, ref, slots, context.read_only))
            for ref in context.run_scenarios
        ]
        progress_task = asyncio.create_task(self.publish_progress_loop(run_id))
        try:
            await self.supervise(run_id)
            outcomes = await asyncio.gather(*self.tasks, return_exceptions=True)
        finally:
            self.progress_stopped = True
            await progress_task
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                raise outcome
        if self.stop is not None:
            await self.skip_queued(run_id, self.stop.reason)
            if self.stop.reason is SkipReason.budget_exceeded:
                await self.skip_ungraded(run_id, self.stop.reason)

    async def skip_ungraded(self, run_id: UUID, reason: SkipReason) -> None:
        await call_activity(
            SKIP_UNGRADED_STEPS,
            SkipUngradedStepsInput(run_id=run_id, reason=reason),
            SkipUngradedStepsResult,
        )

    def all_done(self) -> bool:
        return all(task.done() for task in self.tasks)

    def should_wake(self) -> bool:
        return self.cancel_requested or self.stop is not None or self.all_done()

    def stop_requested(self) -> bool:
        return self.cancel_requested or self.stop is not None

    def stop_reason(self) -> SkipReason:
        return self.stop.reason if self.stop is not None else SkipReason.canceled

    async def supervise(self, run_id: UUID) -> None:
        remaining = self.ledger.seconds_left(workflow.now())
        timed_out = remaining <= 0
        if not timed_out:
            try:
                await workflow.wait_condition(self.should_wake, timeout=remaining)
            except TimeoutError:
                timed_out = True
        if self.stop is None and self.cancel_requested:
            self.stop = StopDecision(SkipReason.canceled, None)
        elif self.stop is None and timed_out and not self.all_done():
            self.stop = StopDecision(SkipReason.budget_exceeded, "minutes")
        if self.stop is not None:
            await self.enact_stop(run_id, self.stop)

    async def enact_stop(self, run_id: UUID, decision: StopDecision) -> None:
        if decision.reason is SkipReason.canceled:
            await self.set_status(run_id, RunStatus.canceling)
        elif decision.dimension is not None:
            exhausted = self.ledger.exhaustion(decision.dimension, workflow.now())
            await emit_event(
                run_id, "budget.exhausted", exhausted.model_dump(mode="json"), "budget.exhausted"
            )
        for handle in list(self.active.values()):
            await handle.signal(CANCEL_SIGNAL, decision.reason)

    async def run_one(
        self, run_id: UUID, ref: RunScenarioRef, slots: asyncio.Semaphore, read_only: bool
    ) -> None:
        async with slots:
            if self.stop_requested():
                return
            handle: workflow.ChildWorkflowHandle[
                Any, RunScenarioResult
            ] = await workflow.start_child_workflow(
                RUN_SCENARIO_WORKFLOW,
                RunScenarioInput(
                    run_id=run_id,
                    run_scenario_id=ref.id,
                    attempts=ref.attempts_total,
                    read_only=read_only,
                    mode="live",
                    timeout_seconds=ref.timeout_seconds,
                    code_laya_only=self.commit_tier,
                ),
                id=run_scenario_workflow_id(ref.id),
                result_type=RunScenarioResult,
                cancellation_type=workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
                parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
            )
            self.active[ref.id] = handle
            try:
                if self.stop_requested():
                    await handle.signal(CANCEL_SIGNAL, self.stop_reason())
                await handle
            except ChildWorkflowError as error:
                await self.record_child_failure(ref, error)
                return
            finally:
                self.active.pop(ref.id, None)
            self.progress_dirty = True

    async def record_child_failure(self, ref: RunScenarioRef, error: ChildWorkflowError) -> None:
        await call_activity_without_result(
            FINISH_RUN_SCENARIO,
            FinishRunScenarioInput(
                run_scenario_id=ref.id,
                status=RunScenarioStatus.errored,
                verdict=uncertain_verdict(SCENARIO_WORKFLOW_FAILED, failure_text(error)),
            ),
        )
        self.progress_dirty = True

    def enforce_spend(self, published: PublishRunProgressResult) -> None:
        self.ledger.observe(published.spent_usd, published.blocked_calls)
        if self.progress_stopped or self.stop is not None or self.cancel_requested:
            return
        if self.ledger.usd_exhausted():
            self.stop = StopDecision(SkipReason.budget_exceeded, "usd")

    def has_progress_to_publish(self) -> bool:
        return self.progress_dirty or self.progress_stopped

    async def publish_progress_loop(self, run_id: UUID) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await workflow.wait_condition(
                    self.has_progress_to_publish, timeout=BUDGET_POLL_INTERVAL
                )
            if self.progress_stopped:
                return
            self.progress_dirty = False
            published = await self.publish_progress(run_id)
            if published is not None:
                self.enforce_spend(published)
            with contextlib.suppress(TimeoutError):
                await workflow.wait_condition(
                    lambda: self.progress_stopped, timeout=PROGRESS_EVENT_MIN_INTERVAL
                )

    async def publish_progress(self, run_id: UUID) -> PublishRunProgressResult | None:
        if self.started_ledger is None:
            return None
        self.progress_sequence += 1
        try:
            published = await call_activity(
                PUBLISH_RUN_PROGRESS,
                PublishRunProgressInput(
                    run_id=run_id,
                    sequence=self.progress_sequence,
                    budget=self.started_ledger.state(workflow.now()),
                ),
                PublishRunProgressResult,
            )
        except ActivityError as error:
            workflow.logger.warning(
                "run_progress_not_published", extra={"cause": failure_text(error)}
            )
            return None
        self.counters = published.counters
        return published
