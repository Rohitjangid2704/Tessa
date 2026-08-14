import asyncio
import contextlib
import logging
import traceback
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import JsonValue, ValidationError
from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert
from temporalio import activity

from tessa_api.db.models import BrowserSessionRow, RunRow, RunScenarioRow, ScenarioRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.artifacts import StoredArtifact
from tessa_api.schemas.common import Verdict, Viewport
from tessa_api.schemas.enums import (
    AdapterKind,
    ArtifactKind,
    BrowserSessionStatus,
    RunScenarioStatus,
    VerdictStatus,
)
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.schemas.steps import (
    BrowserStepResponse,
    Tier0Failure,
    Tier0Result,
)
from tessa_api.schemas.streams import (
    BrowserSessionEndedPayload,
    BrowserSessionStartedPayload,
    StepRecordedPayload,
)
from tessa_api.schemas.temporal import (
    DRIVE_SCENARIO_ATTEMPT_ACTIVITY,
    AttemptResult,
    DriveAttemptInput,
)
from tessa_api.services.artifact_store import ArtifactStore
from tessa_api.services.scenario_variables import with_run_marker
from tessa_worker.activities.drive_ports import (
    AdapterOpener,
    AdapterOpenError,
    AdapterOpenRequest,
    LiveSessionAdapter,
    NoStepHooks,
    OpenedAdapter,
    StepAssessment,
    StepContext,
    StepHooks,
)
from tessa_worker.activities.run_context import scenario_timeout_seconds
from tessa_worker.adapters.base import ProducedArtifact, StepRecord
from tessa_worker.adapters.errors import StepRefusedError
from tessa_worker.checks.contracts import Tier0Evaluator
from tessa_worker.event_client import EventBatcher, EventClient, build_event
from tessa_worker.settings import WorkerSettings
from tessa_worker.verdicts import (
    ATTEMPT_ERRORED,
    SCENARIO_TIMEOUT,
    STEP_NOT_COMPLETED,
    TIER0_FAILED,
    fail_verdict,
    pass_verdict,
    skipped_verdict,
    uncertain_verdict,
)

logger = logging.getLogger("tessa_worker.drive")

DEFAULT_VIEWPORT = Viewport(width=1280, height=720)
DRIVE_HEARTBEAT_SECONDS = 2.0
ADAPTER_CLOSE_TIMEOUT_SECONDS = 30.0
ERROR_TEXT_LIMIT = 300
LOOP_OWNED_STEP_COLUMNS = frozenset(
    {
        "id",
        "run_scenario_id",
        "run_id",
        "attempt",
        "index",
        "adapter",
        "label",
        "request",
        "response",
        "response_truncated",
        "ask",
        "answer",
        "tools",
        "cards",
        "tier0",
        "latency_ms",
        "cost_usd",
        "artifacts",
        "ok",
        "tier0_failure_count",
        "screenshot_count",
        "started_at",
        "finished_at",
    }
)
STEP_TABLE_COLUMNS = frozenset(column.name for column in StepRow.__table__.columns)
USD_QUANTUM = Decimal("0.000001")


class AttemptSetupError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class LoadedAttempt:
    target_id: UUID
    bundle_id: UUID
    role: str
    interface_id: str
    scenario: ScenarioDoc
    timeout_seconds: int


@dataclass(frozen=True, slots=True)
class PersistedStep:
    step_id: UUID
    index: int
    screenshots: int


@dataclass(frozen=True, slots=True)
class StepFinding:
    index: int
    label: str
    ok: bool | None
    error: str | None
    failures: tuple[Tier0Failure, ...]
    hook_verdict: Verdict | None


@dataclass(slots=True)
class AttemptProgress:
    step_index: int = -1
    steps_recorded: int = 0

    def details(self) -> dict[str, int]:
        return {"step_index": self.step_index, "steps_recorded": self.steps_recorded}


@contextlib.asynccontextmanager
async def heartbeating(
    interval_seconds: float, details: Callable[[], Mapping[str, int]]
) -> AsyncIterator[None]:
    async def beat() -> None:
        while True:
            activity.heartbeat(details())
            await asyncio.sleep(interval_seconds)

    beating = asyncio.create_task(beat())
    try:
        yield
    finally:
        beating.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beating


def utc_now() -> datetime:
    return datetime.now(UTC)


def to_money(value: float) -> Decimal:
    return Decimal(str(value)).quantize(USD_QUANTUM)


def validated_step_columns(columns: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
    unknown = set(columns) - STEP_TABLE_COLUMNS
    owned = set(columns) & LOOP_OWNED_STEP_COLUMNS
    if unknown or owned:
        raise ValueError(
            f"step hooks may only set extra step columns; rejected {sorted(unknown | owned)}"
        )
    return dict(columns)


def compose_attempt_verdict(findings: Sequence[StepFinding]) -> Verdict:
    for finding in findings:
        if finding.hook_verdict is not None and finding.hook_verdict.status is VerdictStatus.fail:
            return finding.hook_verdict
        if finding.ok is False:
            detail = finding.error or "no detail was reported"
            return fail_verdict(
                f"step {finding.index + 1} ({finding.label}) did not complete: {detail}",
                STEP_NOT_COMPLETED,
            )
        if finding.failures:
            first = finding.failures[0]
            return fail_verdict(
                f"step {finding.index + 1} ({finding.label}): {first.check.value}: {first.message}",
                TIER0_FAILED,
            )
    for finding in findings:
        if (
            finding.hook_verdict is not None
            and finding.hook_verdict.status is not VerdictStatus.pass_
        ):
            return finding.hook_verdict
    return pass_verdict()


class DriveActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        adapters: AdapterOpener,
        artifacts: ArtifactStore,
        tier0: Tier0Evaluator,
        hooks: StepHooks | None = None,
        heartbeat_interval_seconds: float = DRIVE_HEARTBEAT_SECONDS,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self.adapters = adapters
        self.artifacts = artifacts
        self.tier0 = tier0
        self.hooks: StepHooks = hooks or NoStepHooks()
        self.heartbeat_interval_seconds = heartbeat_interval_seconds

    @activity.defn(name=DRIVE_SCENARIO_ATTEMPT_ACTIVITY)
    async def drive_scenario_attempt(self, request: DriveAttemptInput) -> AttemptResult:
        progress = AttemptProgress()
        async with (
            self.events.batcher() as batcher,
            heartbeating(self.heartbeat_interval_seconds, progress.details),
        ):
            attempt = AttemptRun(self, request, batcher, progress)
            return await attempt.execute()


class AttemptRun:
    def __init__(
        self,
        owner: DriveActivities,
        request: DriveAttemptInput,
        batcher: EventBatcher,
        progress: AttemptProgress,
    ) -> None:
        self.owner = owner
        self.request = request
        self.batcher = batcher
        self.progress = progress
        self.opened: OpenedAdapter | None = None
        self.session_id: UUID = new_id()
        self.session_started = False
        self.scenario_title = ""
        self.cost_usd = 0.0
        self.step_traces: list[StoredArtifact] = []

    async def execute(self) -> AttemptResult:
        try:
            loaded = await self.load()
            return await self.run_within_timeout(loaded)
        except AttemptSetupError as error:
            return self.errored(str(error))
        except AdapterOpenError as error:
            logger.warning(
                "drive_adapter_not_opened",
                extra={
                    "run_scenario_id": str(self.request.run_scenario_id),
                    "reason": str(error),
                },
            )
            if error.skip_reason is not None:
                return self.halted(skipped_verdict(error.skip_reason, str(error)))
            return self.errored(str(error))
        except Exception as error:
            logger.error(
                "drive_attempt_failed",
                extra={
                    "run_scenario_id": str(self.request.run_scenario_id),
                    "attempt": self.request.attempt,
                    **self.failure_fields(error),
                },
            )
            return self.errored(f"{type(error).__name__}: {error}")
        finally:
            await self.release()

    async def run_within_timeout(self, loaded: LoadedAttempt) -> AttemptResult:
        limit = asyncio.timeout(loaded.timeout_seconds)
        try:
            async with limit:
                return await self.run_steps(loaded)
        except TimeoutError:
            if not limit.expired():
                raise
            return self.finished(
                fail_verdict(
                    f"the scenario exceeded its timeout of {loaded.timeout_seconds} seconds",
                    SCENARIO_TIMEOUT,
                )
            )

    async def load(self) -> LoadedAttempt:
        async with self.owner.session_factory() as session:
            run_scenario = await session.get(RunScenarioRow, self.request.run_scenario_id)
            run = await session.get(RunRow, self.request.run_id)
            if run_scenario is None or run is None:
                raise AttemptSetupError("the run or the run scenario no longer exists")
            scenario = await session.get(ScenarioRow, run_scenario.scenario_id)
            if scenario is None:
                raise AttemptSetupError("the scenario no longer exists")
            if run.target_id is None or run.bundle_id is None:
                raise AttemptSetupError("the run has no target or bundle")
            try:
                document = ScenarioDoc.model_validate(scenario.parsed)
            except ValidationError as error:
                raise AttemptSetupError(
                    f"the scenario document is invalid ({error.error_count()} errors)"
                ) from error
            self.scenario_title = scenario.title
            return LoadedAttempt(
                target_id=run.target_id,
                bundle_id=run.bundle_id,
                role=run_scenario.role,
                interface_id=run_scenario.interface_id,
                scenario=document,
                timeout_seconds=scenario_timeout_seconds(
                    scenario.parsed, self.owner.settings.scenario_timeout_seconds
                ),
            )

    async def run_steps(self, loaded: LoadedAttempt) -> AttemptResult:
        opened = await self.owner.adapters.open(
            AdapterOpenRequest(
                target_id=loaded.target_id,
                bundle_id=loaded.bundle_id,
                role=loaded.role,
                interface_id=loaded.interface_id,
                run_id=self.request.run_id,
                run_scenario_id=self.request.run_scenario_id,
                attempt=self.request.attempt,
                read_only=self.request.read_only,
                step_timeout_seconds=float(loaded.timeout_seconds),
                browser_session_id=self.session_id,
            )
        )
        self.opened = opened
        if opened.adapter.kind is AdapterKind.browser:
            await self.start_session(opened)
        findings: list[StepFinding] = []
        for index, step in enumerate(loaded.scenario.steps):
            self.progress.step_index = index
            context = StepContext(
                run_id=self.request.run_id,
                run_scenario_id=self.request.run_scenario_id,
                attempt=self.request.attempt,
                index=index,
                read_only=self.request.read_only,
                scenario=loaded.scenario,
                step=with_run_marker(step, self.request.run_id),
            )
            prepared = await self.owner.hooks.before_step(context)
            if prepared.halt is not None:
                return self.halted(prepared.halt)
            try:
                record = await opened.adapter.drive(prepared.step)
            except StepRefusedError as refusal:
                reason = self.redacted(str(refusal))
                return self.halted(skipped_verdict(refusal.skip_reason, reason))
            tier0 = self.owner.tier0(record, prepared.step.expect, opened.tier0_context)
            persisted = await self.persist_step(index, record, tier0, prepared.step_columns)
            assessment = await self.owner.hooks.after_step(
                context, persisted.step_id, record, tier0
            )
            merged = await self.apply_assessment(persisted, tier0, assessment)
            self.announce_step(persisted, record, len(merged.failures))
            findings.append(
                StepFinding(
                    index=index,
                    label=record.label,
                    ok=record.ok,
                    error=record.error,
                    failures=tuple(merged.failures),
                    hook_verdict=assessment.verdict,
                )
            )
            if record.ok is False:
                break
        return self.finished(compose_attempt_verdict(findings))

    async def persist_step(
        self,
        index: int,
        record: StepRecord,
        tier0: Tier0Result,
        prepared_columns: Mapping[str, JsonValue],
    ) -> PersistedStep:
        stored = await self.file_artifacts(record.artifacts)
        self.step_traces.extend(item for item in stored if item.kind is ArtifactKind.trace)
        extra_columns = validated_step_columns(prepared_columns)
        screenshots = sum(item.kind is ArtifactKind.screenshot for item in stored)
        values: dict[str, Any] = {
            "run_scenario_id": self.request.run_scenario_id,
            "run_id": self.request.run_id,
            "attempt": self.request.attempt,
            "index": index,
            "adapter": record.adapter,
            "label": record.label,
            "request": record.request.model_dump(mode="json"),
            "response": None
            if record.response is None
            else record.response.model_dump(mode="json"),
            "response_truncated": record.response_truncated,
            "ask": record.ask,
            "answer": record.answer,
            "tools": [tool.model_dump(mode="json") for tool in record.tools],
            "cards": record.cards,
            "tier0": tier0.model_dump(mode="json"),
            "latency_ms": record.latency_ms,
            "cost_usd": to_money(record.cost_usd),
            "artifacts": [item.model_dump(mode="json") for item in stored],
            "ok": record.ok,
            "tier0_failure_count": len(tier0.failures),
            "screenshot_count": screenshots,
            "started_at": record.started_at,
            "finished_at": record.finished_at,
            **extra_columns,
        }
        async with self.owner.session_factory() as session:
            step_id = await session.scalar(
                insert(StepRow)
                .values(id=new_id(), **values)
                .on_conflict_do_update(
                    index_elements=[StepRow.run_scenario_id, StepRow.attempt, StepRow.index],
                    set_=values,
                )
                .returning(StepRow.id)
            )
            if self.session_started and isinstance(record.response, BrowserStepResponse):
                await session.execute(
                    update(BrowserSessionRow)
                    .where(BrowserSessionRow.id == self.session_id)
                    .values(last_url=record.response.url)
                )
            await session.commit()
        if step_id is None:
            raise RuntimeError("the step upsert returned no id")
        self.cost_usd += record.cost_usd
        self.progress.steps_recorded += 1
        return PersistedStep(step_id=step_id, index=index, screenshots=screenshots)

    async def apply_assessment(
        self, persisted: PersistedStep, tier0: Tier0Result, assessment: StepAssessment
    ) -> Tier0Result:
        if not assessment.failures and not assessment.step_columns:
            return tier0
        merged = Tier0Result(
            passed=tier0.passed and not assessment.failures,
            failures=[*tier0.failures, *assessment.failures],
        )
        values: dict[str, Any] = {
            "tier0": merged.model_dump(mode="json"),
            "tier0_failure_count": len(merged.failures),
            **validated_step_columns(assessment.step_columns),
        }
        async with self.owner.session_factory() as session:
            await session.execute(
                update(StepRow).where(StepRow.id == persisted.step_id).values(**values)
            )
            await session.commit()
        return merged

    def announce_step(
        self, persisted: PersistedStep, record: StepRecord, failure_count: int
    ) -> None:
        self.batcher.add(
            build_event(
                self.request.run_id,
                "step.recorded",
                StepRecordedPayload(
                    step_id=persisted.step_id,
                    run_scenario_id=self.request.run_scenario_id,
                    attempt=self.request.attempt,
                    index=persisted.index,
                    adapter=record.adapter,
                    label=record.label,
                    ok=record.ok,
                    latency_ms=record.latency_ms,
                    cost_usd=record.cost_usd,
                    tier0_failure_count=failure_count,
                    screenshot_count=persisted.screenshots,
                ),
                f"step.recorded:{self.request.run_scenario_id}:{self.request.attempt}:"
                f"{persisted.index}",
            )
        )

    async def file_artifacts(self, produced: Sequence[ProducedArtifact]) -> list[StoredArtifact]:
        stored: list[StoredArtifact] = []
        for item in produced:
            stored.append(await self.owner.artifacts.put(new_id(), item.path, item.kind, item.mime))
            item.path.unlink(missing_ok=True)
        return stored

    async def start_session(self, opened: OpenedAdapter) -> None:
        adapter = opened.adapter
        viewport = adapter.viewport if isinstance(adapter, LiveSessionAdapter) else DEFAULT_VIEWPORT
        started_at = utc_now()
        async with self.owner.session_factory() as session:
            session.add(
                BrowserSessionRow(
                    id=self.session_id,
                    run_id=self.request.run_id,
                    run_scenario_id=self.request.run_scenario_id,
                    attempt=self.request.attempt,
                    status=BrowserSessionStatus.active,
                    viewport=viewport.model_dump(mode="json"),
                    started_at=started_at,
                )
            )
            await session.commit()
        self.session_started = True
        self.batcher.add(
            build_event(
                self.request.run_id,
                "browser_session.started",
                BrowserSessionStartedPayload(
                    browser_session_id=self.session_id,
                    run_scenario_id=self.request.run_scenario_id,
                    attempt=self.request.attempt,
                    viewport=viewport,
                    scenario_title=self.scenario_title,
                    started_at=started_at,
                ),
                f"browser_session.started:{self.session_id}",
            )
        )

    async def end_session(self, produced: Sequence[ProducedArtifact]) -> None:
        stored = await self.file_artifacts(produced)
        recording = next((item for item in stored if item.kind is ArtifactKind.recording), None)
        trace = next(
            (item for item in stored if item.kind is ArtifactKind.trace),
            self.step_traces[0] if self.step_traces else None,
        )
        ended_at = utc_now()
        async with self.owner.session_factory() as session:
            await session.execute(
                update(BrowserSessionRow)
                .where(BrowserSessionRow.id == self.session_id)
                .values(
                    status=BrowserSessionStatus.ended,
                    ended_at=ended_at,
                    recording=None if recording is None else recording.model_dump(mode="json"),
                    trace=None if trace is None else trace.model_dump(mode="json"),
                )
            )
            await session.commit()
        self.batcher.add(
            build_event(
                self.request.run_id,
                "browser_session.ended",
                BrowserSessionEndedPayload(
                    browser_session_id=self.session_id,
                    run_scenario_id=self.request.run_scenario_id,
                    has_recording=recording is not None,
                    has_trace=trace is not None,
                    ended_at=ended_at,
                ),
                f"browser_session.ended:{self.session_id}",
            )
        )

    async def release(self) -> None:
        opened = self.opened
        if opened is None:
            return
        produced: Sequence[ProducedArtifact] = ()
        try:
            async with asyncio.timeout(ADAPTER_CLOSE_TIMEOUT_SECONDS):
                await opened.adapter.close()
                if self.session_started and isinstance(opened.adapter, LiveSessionAdapter):
                    produced = await opened.adapter.session_artifacts()
        except Exception as error:
            logger.error(
                "drive_adapter_close_failed",
                extra={
                    "run_scenario_id": str(self.request.run_scenario_id),
                    **self.failure_fields(error),
                },
            )
        if self.session_started:
            try:
                await self.end_session(produced)
            except Exception as error:
                logger.error(
                    "drive_session_end_failed",
                    extra={
                        "browser_session_id": str(self.session_id),
                        **self.failure_fields(error),
                    },
                )

    def failure_fields(self, error: BaseException) -> dict[str, str]:
        frames = traceback.extract_tb(error.__traceback__)
        origin = f"{Path(frames[-1].filename).name}:{frames[-1].lineno}" if frames else ""
        return {
            "error_type": type(error).__name__,
            "error": self.redacted(str(error)),
            "origin": origin,
        }

    def redacted(self, text: str) -> str:
        shortened = text[:ERROR_TEXT_LIMIT]
        return shortened if self.opened is None else self.opened.redact(shortened)

    def finished(self, verdict: Verdict) -> AttemptResult:
        return AttemptResult(
            status=RunScenarioStatus.finished,
            steps_recorded=self.progress.steps_recorded,
            cost_usd=self.cost_usd,
            browser_session_id=self.session_id if self.session_started else None,
            verdict=verdict,
            error=None,
        )

    def halted(self, verdict: Verdict) -> AttemptResult:
        result = self.finished(verdict)
        if verdict.status is VerdictStatus.skipped:
            return result.model_copy(update={"status": RunScenarioStatus.skipped})
        return result

    def errored(self, reason: str) -> AttemptResult:
        text = self.redacted(reason)
        return AttemptResult(
            status=RunScenarioStatus.errored,
            steps_recorded=self.progress.steps_recorded,
            cost_usd=self.cost_usd,
            browser_session_id=self.session_id if self.session_started else None,
            verdict=uncertain_verdict(ATTEMPT_ERRORED, text),
            error=text,
        )
