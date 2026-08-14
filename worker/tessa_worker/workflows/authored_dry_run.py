import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

from temporalio import workflow
from temporalio.exceptions import (
    ActivityError,
    ApplicationError,
    ChildWorkflowError,
    FailureError,
)

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.common import BudgetState
    from tessa_api.schemas.enums import RunScenarioStatus, RunStatus, SkipReason
    from tessa_api.schemas.temporal import (
        CANCEL_SIGNAL,
        DRY_RUN_SCENARIO_ACTIVITY,
        FINALIZE_RUN_ACTIVITY,
        RUN_SCENARIO_WORKFLOW,
        UPDATE_RUN_STATUS_ACTIVITY,
        DryRunScenarioInput,
        DryRunScenarioResult,
        FinalizeRunInput,
        FinalizeRunResult,
        PlanCoverageInput,
        PlanCoverageProgress,
        PlanCoverageResult,
        RunScenarioInput,
        RunScenarioResult,
        UpdateRunStatusInput,
        UpdateRunStatusResult,
        run_scenario_workflow_id,
    )
    from tessa_worker.activities.dry_run_models import (
        LOAD_DRY_RUN_CONTEXT,
        PREPARE_DRY_RUN,
        SKIP_DRY_RUN,
        DryRunContext,
        LoadDryRunContextInput,
        PreparedDryRun,
        PrepareDryRunInput,
        SkipDryRunInput,
        SkipDryRunResult,
    )
    from tessa_worker.activities.names import (
        FINISH_RUN_SCENARIO,
        FREEZE_RUN_CONFIG,
        PUBLISH_RUN_PROGRESS,
    )
    from tessa_worker.activities.run_models import (
        FinishRunScenarioInput,
        FreezeRunConfigInput,
        FreezeRunConfigResult,
        PublishRunProgressInput,
        PublishRunProgressResult,
    )
    from tessa_worker.events import emit_event
    from tessa_worker.verdicts import SCENARIO_WORKFLOW_FAILED, uncertain_verdict
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_result,
        failure_text,
    )
    from tessa_worker.workflows.ledger import BudgetDimension, BudgetLedger
    from tessa_worker.workflows.seed_assertion import assert_run_seed

FREEZE_RUN_CONFIG_START_TO_CLOSE = timedelta(seconds=90)
CANCELED_REASON = "canceled by request"
SEED_UNUSABLE_REASON = "the seed could not be asserted"
MAX_NOTICES = 5
UNSTARTED_BUDGET = BudgetState(max_usd=0.0, spent_usd=0.0, max_minutes=1, elapsed_ms=0)


def joined_reason(*parts: str | None) -> str | None:
    present = [part for part in parts if part]
    return "; ".join(present) if present else None


@dataclass(frozen=True, slots=True)
class StopDecision:
    reason: SkipReason
    dimension: BudgetDimension | None


class AuthoredDryRun:
    def __init__(self, request: PlanCoverageInput, cancel_requested: Callable[[], bool]) -> None:
        self.request = request
        self.cancel_requested = cancel_requested
        self.dry_run_failures = 0
        self.stop: StopDecision | None = None
        self.notices: list[str] = []
        self.dry_runs_blocked: str | None = None
        self.finished = False
        self.ledger: BudgetLedger | None = None
        self.context: DryRunContext | None = None
        self.dry_slots = asyncio.Semaphore(1)
        self.active: dict[UUID, workflow.ChildWorkflowHandle[Any, RunScenarioResult]] = {}
        self.run_sequence = 0

    @property
    def run_id(self) -> UUID:
        return self.request.run_id

    @property
    def scenario_ids(self) -> list[UUID]:
        return list(self.request.scenario_ids or [])

    def progress(self) -> PlanCoverageProgress:
        return PlanCoverageProgress(
            cells_total=0,
            cells_done=0,
            scenarios_created=0,
            scenarios_reused=0,
            scenarios_invalid=0,
        )

    def result(self) -> PlanCoverageResult:
        return PlanCoverageResult(
            cells_total=0,
            scenarios_created=0,
            scenarios_reused=0,
            scenarios_invalid=0,
            dry_run_failures=self.dry_run_failures,
        )

    async def run(self) -> PlanCoverageResult:
        try:
            return await self.execute()
        except asyncio.CancelledError:
            self.finished = True
            await self.conclude(RunStatus.canceled, CANCELED_REASON)
            raise
        except Exception as error:
            self.finished = True
            await self.conclude(RunStatus.failed, failure_text(error))
            if isinstance(error, FailureError):
                raise
            raise ApplicationError(failure_text(error), non_retryable=True) from error

    async def execute(self) -> PlanCoverageResult:
        context = await call_activity(
            LOAD_DRY_RUN_CONTEXT, LoadDryRunContextInput(run_id=self.run_id), DryRunContext
        )
        self.context = context
        self.ledger = BudgetLedger(budget=context.budget, started_at=workflow.now())
        self.dry_slots = asyncio.Semaphore(context.dry_run_concurrency)
        await self.set_status(RunStatus.planning)
        await call_activity(
            FREEZE_RUN_CONFIG,
            FreezeRunConfigInput(run_id=self.run_id),
            FreezeRunConfigResult,
            FREEZE_RUN_CONFIG_START_TO_CLOSE,
        )
        if self.cancel_requested():
            return await self.cancel_before_running()
        await self.set_status(RunStatus.seeding)
        seed = await assert_run_seed(self.run_id, False, self.cancel_requested)
        if self.cancel_requested():
            return await self.cancel_before_running()
        if seed.outcome in ("mismatch", "failed"):
            self.block_dry_runs(seed.reason or SEED_UNUSABLE_REASON)
        await self.set_status(RunStatus.running, seed.reason)
        supervisor = asyncio.create_task(self.supervise())
        try:
            await asyncio.gather(*(self.dry_run(item) for item in self.scenario_ids))
        finally:
            self.finished = True
            await supervisor
        return await self.conclude(self.final_status(), self.final_reason())

    def block_dry_runs(self, reason: str) -> None:
        self.dry_runs_blocked = reason
        self.notices.append(f"dry runs were skipped: {reason}")

    async def cancel_before_running(self) -> PlanCoverageResult:
        self.finished = True
        await self.set_status(RunStatus.canceling)
        return await self.conclude(RunStatus.canceled, CANCELED_REASON)

    def stopped(self) -> bool:
        return self.cancel_requested() or self.stop is not None

    def stop_reason(self) -> SkipReason:
        return self.stop.reason if self.stop is not None else SkipReason.canceled

    def exhaust_usd(self) -> None:
        if self.stop is None and not self.cancel_requested():
            self.stop = StopDecision(SkipReason.budget_exceeded, "usd")

    def should_wake(self) -> bool:
        return self.finished or self.cancel_requested() or self.stop is not None

    async def supervise(self) -> None:
        ledger = self.ledger
        if ledger is None:
            return
        remaining = ledger.seconds_left(workflow.now())
        timed_out = remaining <= 0
        if not timed_out:
            try:
                await workflow.wait_condition(self.should_wake, timeout=remaining)
            except TimeoutError:
                timed_out = True
        if self.finished and self.stop is None:
            return
        if self.stop is None and self.cancel_requested():
            self.stop = StopDecision(SkipReason.canceled, None)
        elif self.stop is None and timed_out:
            self.stop = StopDecision(SkipReason.budget_exceeded, "minutes")
        if self.stop is not None:
            await self.enact_stop(self.stop)

    async def enact_stop(self, decision: StopDecision) -> None:
        if decision.reason is SkipReason.canceled:
            await self.set_status(RunStatus.canceling)
        elif decision.dimension is not None and self.ledger is not None:
            await self.publish_run_progress()
            exhausted = self.ledger.exhaustion(decision.dimension, workflow.now())
            await emit_event(
                self.run_id,
                "budget.exhausted",
                exhausted.model_dump(mode="json"),
                "budget.exhausted",
            )
        for handle in list(self.active.values()):
            await handle.signal(CANCEL_SIGNAL, decision.reason)

    async def dry_run(self, scenario_id: UUID) -> None:
        skipped = self.skip_reason()
        if skipped is not None:
            await self.skip_dry_run(scenario_id, skipped)
            return
        try:
            async with self.dry_slots:
                skipped = self.skip_reason()
                if skipped is not None:
                    await self.skip_dry_run(scenario_id, skipped)
                    return
                await self.execute_dry_run(scenario_id)
        except ActivityError as error:
            self.notices.append(f"dry run of {scenario_id} failed: {failure_text(error)}")
            await self.skip_dry_run(
                scenario_id, f"the dry run could not run: {failure_text(error)}"
            )

    def skip_reason(self) -> str | None:
        if self.dry_runs_blocked is not None:
            return self.dry_runs_blocked
        if self.stopped():
            return "the run stopped before the dry runs"
        return None

    async def skip_dry_run(self, scenario_id: UUID, reason: str) -> None:
        try:
            await call_activity(
                SKIP_DRY_RUN,
                SkipDryRunInput(run_id=self.run_id, scenario_id=scenario_id, reason=reason[:300]),
                SkipDryRunResult,
            )
        except ActivityError as error:
            self.notices.append(
                f"scenario {scenario_id} was left without a note: {failure_text(error)}"
            )

    async def execute_dry_run(self, scenario_id: UUID) -> None:
        context = self.context
        if context is None:
            return
        prepared = await call_activity(
            PREPARE_DRY_RUN,
            PrepareDryRunInput(
                run_id=self.run_id, scenario_id=scenario_id, repeats=context.dry_run_repeats
            ),
            PreparedDryRun,
        )
        if prepared.outcome != "ready" or prepared.run_scenario_id is None:
            return
        await self.run_child(prepared.run_scenario_id, prepared)
        recorded = await call_activity(
            DRY_RUN_SCENARIO_ACTIVITY,
            DryRunScenarioInput(run_id=self.run_id, scenario_id=scenario_id),
            DryRunScenarioResult,
        )
        if not recorded.passed_twice:
            self.dry_run_failures += 1
        await self.publish_run_progress()

    async def run_child(self, run_scenario_id: UUID, prepared: PreparedDryRun) -> None:
        handle: workflow.ChildWorkflowHandle[
            Any, RunScenarioResult
        ] = await workflow.start_child_workflow(
            RUN_SCENARIO_WORKFLOW,
            RunScenarioInput(
                run_id=self.run_id,
                run_scenario_id=run_scenario_id,
                attempts=prepared.attempts,
                read_only=False,
                mode="dry_run",
                timeout_seconds=prepared.timeout_seconds,
            ),
            id=run_scenario_workflow_id(run_scenario_id),
            result_type=RunScenarioResult,
            cancellation_type=workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
            parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
        )
        self.active[run_scenario_id] = handle
        try:
            if self.stopped():
                await handle.signal(CANCEL_SIGNAL, self.stop_reason())
            await handle
        except ChildWorkflowError as error:
            await call_activity_without_result(
                FINISH_RUN_SCENARIO,
                FinishRunScenarioInput(
                    run_scenario_id=run_scenario_id,
                    status=RunScenarioStatus.errored,
                    verdict=uncertain_verdict(SCENARIO_WORKFLOW_FAILED, failure_text(error)),
                ),
            )
        finally:
            self.active.pop(run_scenario_id, None)

    def budget_state(self) -> BudgetState:
        if self.ledger is None:
            return UNSTARTED_BUDGET
        return self.ledger.state(workflow.now())

    async def publish_run_progress(self) -> None:
        if self.ledger is None:
            return
        self.run_sequence += 1
        try:
            published = await call_activity(
                PUBLISH_RUN_PROGRESS,
                PublishRunProgressInput(
                    run_id=self.run_id, sequence=self.run_sequence, budget=self.budget_state()
                ),
                PublishRunProgressResult,
            )
        except ActivityError as error:
            workflow.logger.warning(
                "run_progress_not_published", extra={"cause": failure_text(error)}
            )
            return
        self.observe_spend(published.spent_usd, published.blocked_calls)

    def observe_spend(self, spent_usd: float, blocked_calls: int) -> None:
        if self.ledger is None:
            return
        self.ledger.observe(spent_usd, blocked_calls)
        if self.ledger.usd_exhausted():
            self.exhaust_usd()

    async def set_status(self, status: RunStatus, reason: str | None = None) -> None:
        await call_activity(
            UPDATE_RUN_STATUS_ACTIVITY,
            UpdateRunStatusInput(run_id=self.run_id, status=status, reason=reason),
            UpdateRunStatusResult,
        )

    async def conclude(self, status: RunStatus, reason: str | None) -> PlanCoverageResult:
        await self.publish_run_progress()
        await call_activity(
            FINALIZE_RUN_ACTIVITY, FinalizeRunInput(run_id=self.run_id), FinalizeRunResult
        )
        await self.set_status(status, reason)
        return self.result()

    def final_status(self) -> RunStatus:
        if self.stop is None:
            return RunStatus.completed
        if self.stop.reason is SkipReason.canceled:
            return RunStatus.canceled
        return RunStatus.budget_exceeded

    def final_reason(self) -> str | None:
        notices = self.notices[:MAX_NOTICES]
        if self.stop is None:
            return joined_reason(*notices)
        if self.stop.reason is SkipReason.canceled:
            return joined_reason(CANCELED_REASON, *notices)
        return joined_reason(self.budget_reason(self.stop), *notices)

    def budget_reason(self, decision: StopDecision) -> str | None:
        if self.ledger is None:
            return None
        exhausted = self.ledger.exhaustion(decision.dimension or "minutes", workflow.now())
        return f"{exhausted.dimension} budget of {exhausted.limit:g} exhausted"
