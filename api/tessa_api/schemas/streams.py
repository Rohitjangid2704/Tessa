from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, model_validator

from tessa_api.schemas.common import (
    AttemptTally,
    BudgetState,
    RunCounters,
    Timestamp,
    Verdict,
    Viewport,
)
from tessa_api.schemas.enums import (
    AdapterKind,
    CoverageUpdateReason,
    ExploreActionKind,
    FeedName,
    FindingClass,
    FindingStatus,
    InvariantPack,
    MutationOutcome,
    NotificationKind,
    ProposalItemStatus,
    RunKind,
    RunScenarioStatus,
    RunStatus,
    RunTrigger,
    ScenarioStatus,
    SeedPhase,
    SeedPhaseStatus,
    Severity,
    SimSpeaker,
    SkipReason,
    VerdictStatus,
    VerdictTier,
)
from tessa_api.schemas.events import TileFramePayload
from tessa_api.schemas.notifications import RelativeAppPath
from tessa_api.schemas.sim import TRANSCRIPT_PREVIEW_MAX_CHARS, SimChecks


class TileQuality(BaseModel):
    max_fps: int = Field(description="frames per second ceiling for a tile in this mode")
    quality: int = Field(description="JPEG quality from 1 to 100")
    max_width: int = Field(description="frame width ceiling in pixels")


class StreamLimits(BaseModel):
    max_tiles: int = Field(description="tiles one connection may subscribe to")
    grid: TileQuality = Field(description="quality of a tile shown in the grid")
    focus: TileQuality = Field(description="quality of the focused tile")


class StreamHelloPayload(BaseModel):
    run_id: UUID | None = Field(description="run of the stream; null on a feed")
    head_seq: int | None = Field(description="highest persisted seq of the run; null on a feed")
    resumed_from: int | None = Field(description="last_seq the client resumed from, if any")
    heartbeat_seconds: int = Field(description="seconds between stream.heartbeat events")
    limits: StreamLimits | None = Field(description="tile limits; null on a feed")
    feed: FeedName | None = Field(description="feed name; null on a run stream")


class StreamReplayEndPayload(BaseModel):
    through_seq: int = Field(description="highest seq replayed before live events begin")


class StreamResyncRequiredPayload(BaseModel):
    reason: Literal["gap_too_large", "retention"] = Field(description="why replay is impossible")
    min_seq: int = Field(description="lowest seq the log can still replay")


class StreamHeartbeatPayload(BaseModel):
    pass


class StreamClosingPayload(BaseModel):
    reason: Literal["max_age", "shutdown", "slow_consumer", "unauthorized"] = Field(
        description="why the server ends the stream; unauthorized means the personal token of "
        "the subscriber was revoked or expired, or its user was deactivated"
    )


class StreamErrorPayload(BaseModel):
    code: str = Field(description="error code from the API error table")
    message: str = Field(description="human readable message")


class HelloTickPayload(BaseModel):
    n: int = Field(description="tick number from 1")
    total: int = Field(description="ticks in this hello run")
    message: str = Field(description="text of the tick")


class HelloLayaPayload(BaseModel):
    ok: bool = Field(description="whether the Laya smoke call succeeded")
    latency_ms: int = Field(description="round trip of the call in milliseconds")
    status_code: int | None = Field(description="HTTP status returned by Laya")
    error: str | None = Field(description="failure description when ok is false")


class RunCreatedPayload(BaseModel):
    kind: RunKind = Field(description="kind of run")
    target_id: UUID | None = Field(description="target the run belongs to")
    plan_id: UUID | None = Field(description="plan the run executes")
    trigger: RunTrigger = Field(description="what started the run")
    created_by: UUID = Field(description="user who started the run")
    status: RunStatus = Field(description="status at creation")


class RunStatusChangedPayload(BaseModel):
    status: RunStatus = Field(description="new status")
    previous: RunStatus = Field(description="status before the change")
    reason: str | None = Field(description="why the status changed")


class RunFinishedPayload(BaseModel):
    status: RunStatus = Field(description="terminal status")
    counters: RunCounters = Field(description="final counters")
    spent_usd: float = Field(description="money spent by the run in USD")
    duration_ms: int = Field(description="run duration in milliseconds")


class BudgetExhaustedPayload(BaseModel):
    dimension: Literal["usd", "minutes"] = Field(description="which budget ran out")
    limit: float = Field(description="the ceiling that was reached")
    actual: float = Field(description="the amount used when the ceiling was reached")


class ScenarioQueuedPayload(BaseModel):
    run_scenario_id: UUID = Field(description="run scenario that was queued")
    scenario_id: UUID = Field(description="scenario the run scenario executes")
    title: str = Field(description="scenario title")
    role: str = Field(description="role the scenario runs as")
    interface_id: str = Field(description="interface the scenario runs against")
    attempts_total: int = Field(description="attempts planned")


class ScenarioStartedPayload(BaseModel):
    run_scenario_id: UUID = Field(description="run scenario that started")
    attempt: int = Field(description="attempt number from 0")


class ScenarioVerdictPayload(BaseModel):
    run_scenario_id: UUID = Field(description="run scenario the verdict belongs to")
    attempt: int = Field(description="attempt number from 0")
    verdict: Verdict = Field(description="verdict of the attempt")


class ScenarioFinishedPayload(BaseModel):
    run_scenario_id: UUID = Field(description="run scenario that finished")
    status: RunScenarioStatus = Field(description="final status")
    verdict: Verdict | None = Field(description="aggregated verdict; null when there is none")
    attempts: AttemptTally = Field(description="attempt outcomes")
    duration_ms: int = Field(description="time from first attempt start to last attempt end")


class StepRecordedPayload(BaseModel):
    step_id: UUID = Field(description="step that was recorded")
    run_scenario_id: UUID = Field(description="run scenario the step belongs to")
    attempt: int = Field(description="attempt number from 0")
    index: int = Field(description="position of the step in the attempt from 0")
    adapter: AdapterKind = Field(description="adapter that drove the step")
    label: str = Field(description="short description of the step")
    ok: bool | None = Field(description="true when the adapter completed the step")
    latency_ms: int = Field(description="step latency in milliseconds")
    cost_usd: float = Field(description="cost the step reported in USD")
    tier0_failure_count: int = Field(description="Tier 0 checks that failed")
    screenshot_count: int = Field(description="screenshots filed for the step")


class BrowserSessionStartedPayload(BaseModel):
    browser_session_id: UUID = Field(description="browser session that started")
    run_scenario_id: UUID = Field(description="run scenario the session belongs to")
    attempt: int = Field(description="attempt number from 0")
    viewport: Viewport = Field(description="size of the browser viewport")
    scenario_title: str = Field(description="scenario title shown on the tile")
    started_at: Timestamp = Field(description="when the session started")


class BrowserSessionEndedPayload(BaseModel):
    browser_session_id: UUID = Field(description="browser session that ended")
    run_scenario_id: UUID = Field(description="run scenario the session belongs to")
    has_recording: bool = Field(description="true when a recording was filed")
    has_trace: bool = Field(description="true when a trace was filed")
    ended_at: Timestamp = Field(description="when the session ended")


class SeedProgressPayload(BaseModel):
    phase: SeedPhase = Field(description="seed phase the event reports")
    status: SeedPhaseStatus = Field(description="progress of the phase")
    observed_hash: str | None = Field(description="hash the hash command observed, once known")
    expected_hash: str | None = Field(description="hash the seed is expected to have, once known")


class StepGradedPayload(BaseModel):
    step_id: UUID = Field(description="step that was graded")
    run_scenario_id: UUID = Field(description="run scenario the step belongs to")
    verdict: Verdict = Field(description="verdict with the tier and confidence that decided it")
    escalated_to: VerdictTier | None = Field(
        description="highest tier the step was escalated to; null when code decided alone"
    )


class InvariantResultPayload(BaseModel):
    invariant_id: str = Field(description="invariant the result belongs to")
    pack: InvariantPack = Field(description="pack of the invariant")
    run_scenario_id: UUID | None = Field(description="run scenario checked; null for run-level")
    attempt: int | None = Field(
        ge=0, description="attempt number from 0; null for run-level results"
    )
    status: VerdictStatus = Field(description="outcome of the invariant")
    tier: VerdictTier = Field(description="tier that decided the outcome")
    message: str = Field(description="short redacted explanation")
    skip_reason: SkipReason | None = Field(description="set exactly when status is skipped")

    @model_validator(mode="after")
    def skip_reason_matches_status(self) -> Self:
        if (self.status is VerdictStatus.skipped) != (self.skip_reason is not None):
            raise ValueError("skip_reason is set exactly when status is skipped")
        return self


class FindingCreatedPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    finding_id: UUID = Field(description="finding the event reports")
    title: str = Field(description="finding title")
    class_: FindingClass = Field(alias="class", description="finding class")
    severity: Severity = Field(description="finding severity")
    status: FindingStatus = Field(description="status at creation")
    fingerprint: str = Field(description="fingerprint the finding was matched or created by")
    is_new: bool = Field(description="false when an existing finding was matched")
    scenario_id: UUID | None = Field(description="scenario that produced the finding")


class FindingChange(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    from_: JsonValue = Field(alias="from", description="value before the change")
    to: JsonValue = Field(description="value after the change")


class FindingUpdatedPayload(BaseModel):
    finding_id: UUID = Field(description="finding that changed")
    changes: dict[str, FindingChange] = Field(description="changed fields by field name")


class FindingOccurrenceAddedPayload(BaseModel):
    finding_id: UUID = Field(description="finding that received an occurrence")
    run_id: UUID = Field(description="run the occurrence belongs to")
    occurrence_count: int = Field(ge=1, description="occurrences of the finding after this one")


class ScenarioChangedPayload(BaseModel):
    scenario_id: UUID = Field(description="scenario that changed")
    status: ScenarioStatus = Field(description="scenario status after the change")
    cell_id: UUID | None = Field(description="coverage cell of the scenario")


class CoverageUpdatedPayload(BaseModel):
    target_id: UUID = Field(description="target whose coverage changed")
    plan_id: UUID | None = Field(description="plan the cells belong to")
    cell_ids: list[UUID] = Field(description="cells whose status or scenario count changed")
    reason: CoverageUpdateReason = Field(description="what changed the cells")


class ExploreActionPayload(BaseModel):
    index: int = Field(ge=0, description="position of the action in the exploration from 0")
    action: ExploreActionKind = Field(description="kind of action the explorer took")
    target: str | None = Field(description="role and name of the element the action addressed")
    text: str | None = Field(description="text typed or read, redacted")
    url: str | None = Field(description="address navigated to")
    rationale: str = Field(description="why the explorer chose the action")


class ExploreCandidatePayload(BaseModel):
    candidate_id: UUID = Field(description="candidate finding awaiting verification")
    description: str = Field(description="what the detector or the explorer claims happened")
    from_index: int = Field(ge=0, description="first recorded action the candidate depends on")
    to_index: int = Field(ge=0, description="last recorded action the candidate depends on")


class ExploreVerifiedPayload(BaseModel):
    candidate_id: UUID = Field(description="candidate that was replayed")
    verified: bool = Field(description="true when every required replay reproduced it")
    replay_run_scenario_id: UUID | None = Field(
        description="run scenario of the last verification replay"
    )
    finding_id: UUID | None = Field(description="finding created for a verified candidate")


class SimTurnPayload(BaseModel):
    sim_session_id: UUID = Field(description="simulated session the turn belongs to")
    turn: int = Field(ge=1, description="turn number from 1")
    speaker: SimSpeaker = Field(description="who spoke")
    text_preview: str = Field(
        max_length=TRANSCRIPT_PREVIEW_MAX_CHARS, description="start of the turn text, redacted"
    )


class SimCheckedPayload(BaseModel):
    sim_session_id: UUID = Field(description="simulated session that was checked")
    checks: SimChecks = Field(description="outcome of each of the five checks")
    verdict: Verdict = Field(description="verdict of the session")


class MutationOutcomePayload(BaseModel):
    mutation_run_id: UUID = Field(description="mutation run the outcome belongs to")
    invariant_id: str = Field(description="expected catcher the outcome is about")
    outcome: MutationOutcome = Field(description="killed, survived, errored or skipped")
    caught_by: list[UUID] = Field(
        description="scenario ids that failed against the mutant and not against the baseline"
    )


class NotificationCreatedPayload(BaseModel):
    notification_id: UUID = Field(description="notification that was created")
    kind: NotificationKind = Field(description="kind of the notification")
    severity: Severity = Field(description="severity of the notification")
    title: str = Field(description="title shown in the bell")
    link: RelativeAppPath = Field(
        description="relative app path with a single leading slash, never an absolute URL"
    )


class DashboardInvalidatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProposalUpdatedPayload(BaseModel):
    target_id: UUID = Field(description="target whose test proposal changed")
    proposal_id: UUID = Field(description="proposal that changed")
    item_id: UUID | None = Field(
        description="item that changed; null when the whole proposal was replaced"
    )
    status: ProposalItemStatus | None = Field(description="new status of that item; null with it")


class AgentSessionChangedPayload(BaseModel):
    agent_session_id: UUID = Field(description="Claude Code session that started, moved or ended")
    user_id: UUID = Field(description="user the session belongs to")
    target_id: UUID | None = Field(description="target the session works on, when it has one")
    active: bool = Field(description="false once the session ended")


class StreamEnvelope(BaseModel):
    run_id: UUID | None = Field(description="run the event belongs to; null for feed-only events")
    seq: int | None = Field(description="per-run sequence from 1; null for ephemeral events")
    ts: Timestamp = Field(description="event time reported by the producer")


class StreamHelloEvent(StreamEnvelope):
    type: Literal["stream.hello"]
    payload: StreamHelloPayload


class StreamReplayEndEvent(StreamEnvelope):
    type: Literal["stream.replay_end"]
    payload: StreamReplayEndPayload


class StreamResyncRequiredEvent(StreamEnvelope):
    type: Literal["stream.resync_required"]
    payload: StreamResyncRequiredPayload


class StreamHeartbeatEvent(StreamEnvelope):
    type: Literal["stream.heartbeat"]
    payload: StreamHeartbeatPayload


class StreamClosingEvent(StreamEnvelope):
    type: Literal["stream.closing"]
    payload: StreamClosingPayload


class StreamErrorEvent(StreamEnvelope):
    type: Literal["stream.error"]
    payload: StreamErrorPayload


class HelloTickEvent(StreamEnvelope):
    type: Literal["hello.tick"]
    payload: HelloTickPayload


class HelloLayaEvent(StreamEnvelope):
    type: Literal["hello.laya"]
    payload: HelloLayaPayload


class RunCreatedEvent(StreamEnvelope):
    type: Literal["run.created"]
    payload: RunCreatedPayload


class RunStatusChangedEvent(StreamEnvelope):
    type: Literal["run.status_changed"]
    payload: RunStatusChangedPayload


class RunFinishedEvent(StreamEnvelope):
    type: Literal["run.finished"]
    payload: RunFinishedPayload


class RunProgressEvent(StreamEnvelope):
    type: Literal["run.progress"]
    payload: RunCounters


class BudgetUpdatedEvent(StreamEnvelope):
    type: Literal["budget.updated"]
    payload: BudgetState


class BudgetExhaustedEvent(StreamEnvelope):
    type: Literal["budget.exhausted"]
    payload: BudgetExhaustedPayload


class ScenarioQueuedEvent(StreamEnvelope):
    type: Literal["scenario.queued"]
    payload: ScenarioQueuedPayload


class ScenarioStartedEvent(StreamEnvelope):
    type: Literal["scenario.started"]
    payload: ScenarioStartedPayload


class ScenarioVerdictEvent(StreamEnvelope):
    type: Literal["scenario.verdict"]
    payload: ScenarioVerdictPayload


class ScenarioFinishedEvent(StreamEnvelope):
    type: Literal["scenario.finished"]
    payload: ScenarioFinishedPayload


class StepRecordedEvent(StreamEnvelope):
    type: Literal["step.recorded"]
    payload: StepRecordedPayload


class BrowserSessionStartedEvent(StreamEnvelope):
    type: Literal["browser_session.started"]
    payload: BrowserSessionStartedPayload


class BrowserSessionEndedEvent(StreamEnvelope):
    type: Literal["browser_session.ended"]
    payload: BrowserSessionEndedPayload


class TileFrameEvent(StreamEnvelope):
    type: Literal["tile.frame"]
    payload: TileFramePayload


class SeedProgressEvent(StreamEnvelope):
    type: Literal["seed.progress"]
    payload: SeedProgressPayload


class StepGradedEvent(StreamEnvelope):
    type: Literal["step.graded"]
    payload: StepGradedPayload


class InvariantResultEvent(StreamEnvelope):
    type: Literal["invariant.result"]
    payload: InvariantResultPayload


class FindingCreatedEvent(StreamEnvelope):
    type: Literal["finding.created"]
    payload: FindingCreatedPayload


class FindingUpdatedEvent(StreamEnvelope):
    type: Literal["finding.updated"]
    payload: FindingUpdatedPayload


class FindingOccurrenceAddedEvent(StreamEnvelope):
    type: Literal["finding.occurrence_added"]
    payload: FindingOccurrenceAddedPayload


class ScenarioChangedEvent(StreamEnvelope):
    type: Literal["scenario.changed"]
    payload: ScenarioChangedPayload


class CoverageUpdatedEvent(StreamEnvelope):
    type: Literal["coverage.updated"]
    payload: CoverageUpdatedPayload


class ExploreActionEvent(StreamEnvelope):
    type: Literal["explore.action"]
    payload: ExploreActionPayload


class ExploreCandidateEvent(StreamEnvelope):
    type: Literal["explore.candidate"]
    payload: ExploreCandidatePayload


class ExploreVerifiedEvent(StreamEnvelope):
    type: Literal["explore.verified"]
    payload: ExploreVerifiedPayload


class SimTurnEvent(StreamEnvelope):
    type: Literal["sim.turn"]
    payload: SimTurnPayload


class SimCheckedEvent(StreamEnvelope):
    type: Literal["sim.checked"]
    payload: SimCheckedPayload


class MutationOutcomeEvent(StreamEnvelope):
    type: Literal["mutation.outcome"]
    payload: MutationOutcomePayload


class NotificationCreatedEvent(StreamEnvelope):
    type: Literal["notification.created"]
    payload: NotificationCreatedPayload


class DashboardInvalidateEvent(StreamEnvelope):
    type: Literal["dashboard.invalidate"]
    payload: DashboardInvalidatePayload


class ProposalUpdatedEvent(StreamEnvelope):
    type: Literal["proposal.updated"]
    payload: ProposalUpdatedPayload


class AgentSessionChangedEvent(StreamEnvelope):
    type: Literal["agent_session.changed"]
    payload: AgentSessionChangedPayload


StreamEvent = Annotated[
    StreamHelloEvent
    | StreamReplayEndEvent
    | StreamResyncRequiredEvent
    | StreamHeartbeatEvent
    | StreamClosingEvent
    | StreamErrorEvent
    | HelloTickEvent
    | HelloLayaEvent
    | RunCreatedEvent
    | RunStatusChangedEvent
    | RunFinishedEvent
    | RunProgressEvent
    | BudgetUpdatedEvent
    | BudgetExhaustedEvent
    | ScenarioQueuedEvent
    | ScenarioStartedEvent
    | ScenarioVerdictEvent
    | ScenarioFinishedEvent
    | StepRecordedEvent
    | BrowserSessionStartedEvent
    | BrowserSessionEndedEvent
    | TileFrameEvent
    | SeedProgressEvent
    | StepGradedEvent
    | InvariantResultEvent
    | FindingCreatedEvent
    | FindingUpdatedEvent
    | FindingOccurrenceAddedEvent
    | ScenarioChangedEvent
    | CoverageUpdatedEvent
    | ExploreActionEvent
    | ExploreCandidateEvent
    | ExploreVerifiedEvent
    | SimTurnEvent
    | SimCheckedEvent
    | MutationOutcomeEvent
    | NotificationCreatedEvent
    | DashboardInvalidateEvent
    | ProposalUpdatedEvent
    | AgentSessionChangedEvent,
    Field(discriminator="type"),
]

stream_event_adapter: TypeAdapter[StreamEvent] = TypeAdapter(StreamEvent)


class TileSubscription(BaseModel):
    browser_session_id: UUID = Field(description="browser session shown by the tile")
    mode: Literal["grid", "focus"] = Field(description="quality mode requested for the tile")


class TileSubscribePayload(BaseModel):
    tiles: list[TileSubscription] = Field(description="complete subscription set of the client")


class TileAckPayload(BaseModel):
    browser_session_id: UUID = Field(description="browser session of the acknowledged tile")
    frame_seq: int = Field(description="highest frame_seq handled; acknowledges all earlier ones")


class TileSubscribeMessage(BaseModel):
    type: Literal["tile.subscribe"]
    payload: TileSubscribePayload


class TileAckMessage(BaseModel):
    type: Literal["tile.ack"]
    payload: TileAckPayload


StreamClientMessage = Annotated[
    TileSubscribeMessage | TileAckMessage,
    Field(discriminator="type"),
]

stream_client_message_adapter: TypeAdapter[StreamClientMessage] = TypeAdapter(StreamClientMessage)


class WsTicketCreate(BaseModel):
    run_id: UUID


class WsTicket(BaseModel):
    ticket: str
    ws_url: str
    expires_at: Timestamp


class RunEvent(BaseModel):
    type: str
    run_id: UUID
    seq: int
    ts: Timestamp
    payload: dict[str, Any]


class RunEventPage(BaseModel):
    items: list[RunEvent]
    head_seq: int
    has_more: bool


class IngestEvent(BaseModel):
    run_id: UUID | None = None
    type: str = Field(min_length=1, max_length=100)
    payload: dict[str, Any]
    dedupe_key: str | None = Field(default=None, max_length=200)
    occurred_at: Timestamp
    ephemeral: bool = False

    @model_validator(mode="after")
    def require_identity_for_durable_events(self) -> Self:
        if not self.ephemeral and (self.run_id is None or not self.dedupe_key):
            raise ValueError("a durable event needs run_id and dedupe_key")
        return self


class IngestEventBatch(BaseModel):
    events: list[IngestEvent] = Field(min_length=1, max_length=500)


class IngestEventResult(BaseModel):
    accepted: int
    deduplicated: int
    seqs: list[int | None]
