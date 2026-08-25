import type { FrameSession, FrameStreamer } from "../server/frames";
import { stableId } from "../stage2/ids";
import type { RunEntry, StageTwoStore } from "../stage2/store";
import type { ArtifactDef, MediaFixture } from "../stage2/types";
import type { MockState, RunRecord } from "../state";
import type {
  BrowserSession,
  RunCounters,
  RunEvent,
  RunScenario,
  RunStatus,
  SkipReason,
  Step,
  StepSummary,
  Verdict,
} from "@/lib/api/types";
import type { AttemptDraft, ScenarioDraft } from "./drafts";
import { extensions } from "./extensions";
import type {
  ScriptContext,
  ScriptEventPayload,
  ScriptEventType,
  StepRecordedContext,
} from "./script";
import { generatedStepPayloads, type StepContent } from "./step-content";

export type ContextMode = { kind: "live" } | { kind: "instant"; baseMs: number };

export const SIMULATION_FRAME_POOL = 4;
export const SESSION_VIEWPORT = { width: 1280, height: 800 };

const MEDIA_TYPES: Readonly<Record<MediaFixture, string>> = {
  png: "image/png",
  webm: "video/webm",
  zip: "application/zip",
};
const USD_DECIMALS = 1_000_000;

interface OpenSession {
  session: BrowserSession;
  frame: FrameSession | null;
}

export function passVerdict(): Verdict {
  return {
    status: "pass",
    tier: "code",
    confidence: 1,
    reason_code: "tier0_passed",
    reason: null,
    skip_reason: null,
  };
}

export function failVerdict(reason: string | null): Verdict {
  return {
    status: "fail",
    tier: "code",
    confidence: 1,
    reason_code: "tier0_failed",
    reason,
    skip_reason: null,
  };
}

export function skippedVerdict(skipReason: SkipReason): Verdict {
  return {
    status: "skipped",
    tier: "code",
    confidence: null,
    reason_code: skipReason,
    reason: null,
    skip_reason: skipReason,
  };
}

export function emptyCounters(): RunCounters {
  return {
    scenarios_total: 0,
    scenarios_done: 0,
    pass: 0,
    fail: 0,
    flaky: 0,
    uncertain: 0,
    skipped: 0,
    steps_recorded: 0,
  };
}

export class RunContext implements ScriptContext {
  atMs = 0;
  private counterDirty = false;
  private readonly startedAt = new Map<string, number>();
  private readonly openSessions = new Map<string, OpenSession>();
  private sessionOrdinal = 0;

  constructor(
    readonly state: MockState,
    readonly store: StageTwoStore,
    readonly entry: RunEntry,
    readonly mode: ContextMode,
  ) {}

  get run(): RunEntry["run"] {
    return this.entry.run;
  }

  get record(): RunRecord {
    return this.entry.record;
  }

  moveTo(atMs: number): void {
    this.atMs = atMs;
    this.run.budget.elapsed_ms = Math.round(atMs);
  }

  timestamp(offsetMs = 0): string {
    const base = this.mode.kind === "live" ? Date.now() : this.mode.baseMs + this.atMs;
    return new Date(base + offsetMs).toISOString();
  }

  emit<Type extends ScriptEventType>(type: Type, payload: ScriptEventPayload<Type>): RunEvent {
    if (this.mode.kind === "live") {
      return this.state.appendRawEvent(this.record, type, payload, this.timestamp());
    }
    const event: RunEvent = {
      type,
      run_id: this.record.id,
      seq: this.record.events.length + 1,
      ts: this.timestamp(),
      payload: { ...payload },
    };
    this.record.events.push(event);
    return event;
  }

  setStatus(status: RunStatus, reason: string | null = null): void {
    const previous = this.run.status;
    if (previous === status) {
      return;
    }
    this.run.status = status;
    if (this.run.started_at === null && previous === "queued") {
      this.run.started_at = this.timestamp();
    }
    this.emit("run.status_changed", { status, previous, reason });
  }

  finish(status: RunStatus, reason: string | null = null): void {
    this.closeAllSessions();
    if (status === "failed") {
      this.setStatus("failed", reason);
    }
    this.run.status = status;
    this.run.finished_at = this.timestamp();
    this.record.finished = true;
    this.emit("run.finished", {
      status,
      counters: { ...this.run.counters },
      spent_usd: this.run.budget.spent_usd,
      duration_ms: Math.round(this.atMs),
    });
  }

  bumpCounters(change: Partial<RunCounters>): void {
    for (const [key, amount] of Object.entries(change)) {
      const name = key as keyof RunCounters;
      this.run.counters[name] += amount;
    }
    this.counterDirty = true;
  }

  addSpend(usd: number): void {
    this.run.budget.spent_usd =
      Math.round((this.run.budget.spent_usd + usd) * USD_DECIMALS) / USD_DECIMALS;
  }

  tickProgress(): void {
    if (this.counterDirty) {
      this.emit("run.progress", { ...this.run.counters });
      this.counterDirty = false;
    }
    this.emit("budget.updated", { ...this.run.budget });
  }

  flushProgress(): void {
    this.emit("run.progress", { ...this.run.counters });
    this.emit("budget.updated", { ...this.run.budget });
    this.counterDirty = false;
  }

  abort(reason: SkipReason): void {
    for (const row of this.store.scenariosOfRun(this.run.id)) {
      if (row.status === "running") {
        this.endRow(row, "canceled");
      } else if (row.status === "queued") {
        this.skipRow(row, reason);
      }
    }
  }

  createRunScenarios(drafts: readonly ScenarioDraft[]): void {
    const pinned: Record<string, number> = {};
    for (const draft of drafts) {
      const row: RunScenario = {
        id: draft.runScenarioId,
        scenario_id: draft.scenario.id,
        title: draft.title,
        family: draft.family,
        role: draft.role,
        interface_id: draft.interfaceId,
        status: "queued",
        verdict: null,
        attempts_total: draft.attemptsTotal,
        attempts_done: 0,
        duration_ms: null,
        attempts: Array.from({ length: draft.attemptsTotal }, (_, attempt) => ({
          attempt,
          status: "queued",
          verdict: null,
        })),
        steps: [],
        scenario_yaml: draft.scenario.yaml,
        skip_reason: null,
      };
      this.store.addRunScenario(this.run.id, row);
      pinned[draft.scenario.id] = draft.scenario.version;
      this.emit("scenario.queued", {
        run_scenario_id: draft.runScenarioId,
        scenario_id: draft.scenario.id,
        title: draft.title,
        role: draft.role,
        interface_id: draft.interfaceId,
        attempts_total: draft.attemptsTotal,
      });
    }
    this.run.config_snapshot.scenario_versions = pinned;
    this.bumpCounters({ scenarios_total: drafts.length });
  }

  private rowOf(draft: Pick<ScenarioDraft, "runScenarioId">): RunScenario {
    const row = this.store.findRunScenario(draft.runScenarioId);
    if (row === undefined) {
      throw new Error(`run scenario ${draft.runScenarioId} was not created`);
    }
    return row;
  }

  startAttempt(draft: ScenarioDraft, attempt: number): void {
    const row = this.rowOf(draft);
    if (!this.startedAt.has(row.id)) {
      this.startedAt.set(row.id, this.atMs);
    }
    row.status = "running";
    const entry = row.attempts[attempt];
    if (entry !== undefined) {
      entry.status = "running";
    }
    this.emit("scenario.started", { run_scenario_id: row.id, attempt });
  }

  openSession(draft: ScenarioDraft, attempt: number): void {
    const row = this.rowOf(draft);
    const id = stableId("browser_session", row.id, attempt);
    const startedAt = this.timestamp();
    const session: BrowserSession = {
      id,
      run_scenario_id: row.id,
      scenario_title: row.title,
      attempt,
      status: "active",
      viewport: { ...SESSION_VIEWPORT },
      last_url: null,
      has_recording: false,
      has_trace: false,
      started_at: startedAt,
      ended_at: null,
    };
    this.store.addBrowserSession(session);
    const frame = this.attachFrameSession(session);
    this.openSessions.set(this.sessionKey(row.id, attempt), { session, frame });
    this.emit("browser_session.started", {
      browser_session_id: id,
      run_scenario_id: row.id,
      attempt,
      viewport: { ...SESSION_VIEWPORT },
      scenario_title: row.title,
      started_at: startedAt,
    });
  }

  closeSession(draft: Pick<ScenarioDraft, "runScenarioId">, attempt: number): void {
    const key = this.sessionKey(draft.runScenarioId, attempt);
    const open = this.openSessions.get(key);
    if (open === undefined) {
      return;
    }
    this.openSessions.delete(key);
    const endedAt = this.timestamp();
    open.session.status = "ended";
    open.session.ended_at = endedAt;
    open.session.has_recording = true;
    open.session.has_trace = true;
    this.detachFrameSession(open.frame);
    this.emit("browser_session.ended", {
      browser_session_id: open.session.id,
      run_scenario_id: open.session.run_scenario_id,
      has_recording: true,
      has_trace: true,
      ended_at: endedAt,
    });
  }

  recordStep(draft: ScenarioDraft, attempt: number, index: number, content: StepContent): Step {
    const row = this.rowOf(draft);
    const id = stableId("step", row.id, attempt, index);
    const defs: ArtifactDef[] = content.artifacts.map((spec) => ({
      id: stableId("artifact", id, spec.kind, spec.key ?? "main"),
      kind: spec.kind,
      mime: MEDIA_TYPES[spec.fixture],
      fixture: spec.fixture,
      stepId: id,
      runId: this.run.id,
    }));
    const step: Step = {
      id,
      run_id: this.run.id,
      run_scenario_id: row.id,
      attempt,
      index,
      adapter: content.adapter,
      label: content.label,
      ...generatedStepPayloads(content),
      response_truncated: content.response_truncated,
      payload_purged: content.payload_purged,
      ask: content.ask,
      answer: content.answer,
      tools: content.tools,
      cards: content.cards,
      latency_ms: content.latency_ms,
      cost_usd: content.cost_usd,
      tier0: content.tier0,
      artifacts: [],
      verdict: content.verdict,
      started_at: this.timestamp(-content.latency_ms),
      finished_at: this.timestamp(),
      gold_points: content.gold_points ?? [],
      db_checks: content.db_checks ?? [],
      probes: content.probes ?? [],
      judge: content.judge ?? null,
      evidence: content.evidence ?? null,
    };
    const summary: StepSummary = {
      id,
      index,
      attempt,
      adapter: content.adapter,
      label: content.label,
      ok: content.ok,
      latency_ms: content.latency_ms,
      cost_usd: content.cost_usd,
      tier0_failure_count: content.tier0.failures.length,
      screenshot_count: content.artifacts.filter((spec) => spec.kind === "screenshot").length,
      verdict: content.verdict,
    };
    this.store.addStep({ step, ok: content.ok, defs }, summary, row);
    this.addSpend(content.cost_usd);
    this.bumpCounters({ steps_recorded: 1 });
    this.touchSessionUrl(row.id, attempt, content);
    this.emit("step.recorded", {
      step_id: id,
      run_scenario_id: row.id,
      attempt,
      index,
      adapter: content.adapter,
      label: content.label,
      ok: content.ok,
      latency_ms: content.latency_ms,
      cost_usd: content.cost_usd,
      tier0_failure_count: summary.tier0_failure_count,
      screenshot_count: summary.screenshot_count,
    });
    this.runStepHooks(step, summary, attempt, row.id);
    return step;
  }

  finishAttempt(draft: ScenarioDraft, attempt: number, drafted: AttemptDraft): Verdict {
    const row = this.rowOf(draft);
    const steps = this.store.stepsOfRunScenario(row.id, attempt);
    const firstFailure = steps.flatMap((step) => step.tier0.failures)[0];
    const defaultVerdict =
      drafted.outcome === "pass" ? passVerdict() : failVerdict(firstFailure?.message ?? null);
    let verdict = defaultVerdict;
    for (const resolver of extensions.attemptVerdictResolvers) {
      const resolved = resolver({
        run: this.run,
        runScenarioId: row.id,
        scenarioId: draft.scenario.id,
        attempt,
        steps,
        defaultVerdict,
        emit: (type, payload) => this.emit(type, payload),
      });
      if (resolved !== null) {
        verdict = resolved;
      }
    }
    const entry = row.attempts[attempt];
    if (entry !== undefined) {
      entry.status = "finished";
      entry.verdict = verdict;
    }
    row.attempts_done = row.attempts.filter((candidate) => candidate.status === "finished").length;
    this.emit("scenario.verdict", { run_scenario_id: row.id, attempt, verdict });
    return verdict;
  }

  finishScenario(draft: Pick<ScenarioDraft, "runScenarioId">): void {
    const row = this.rowOf(draft);
    const verdicts = row.attempts.flatMap((attempt) =>
      attempt.verdict === null ? [] : [attempt.verdict],
    );
    const statuses = new Set(verdicts.map((verdict) => verdict.status));
    const passed = verdicts.filter((verdict) => verdict.status === "pass").length;
    const failed = verdicts.filter((verdict) => verdict.status === "fail").length;
    const first = verdicts[0];
    let verdict: Verdict;
    if (first !== undefined && statuses.size === 1) {
      verdict = { ...first };
    } else if (statuses.has("uncertain")) {
      verdict = {
        status: "uncertain",
        tier: first?.tier ?? "code",
        confidence: null,
        reason_code: "attempts_uncertain",
        reason: "At least one attempt was uncertain",
        skip_reason: null,
      };
    } else {
      verdict = {
        status: "flaky",
        tier: "code",
        confidence: null,
        reason_code: "attempts_disagree",
        reason: `${passed} of ${verdicts.length} attempts passed`,
        skip_reason: null,
      };
    }
    const durationMs = Math.round(this.atMs - (this.startedAt.get(row.id) ?? this.atMs));
    row.status = "finished";
    row.verdict = verdict;
    row.duration_ms = durationMs;
    this.bumpCounters({ scenarios_done: 1, [verdict.status]: 1 });
    this.emit("scenario.finished", {
      run_scenario_id: row.id,
      status: "finished",
      verdict,
      attempts: { passed, failed, total: row.attempts_total },
      duration_ms: durationMs,
    });
  }

  skipScenario(draft: Pick<ScenarioDraft, "runScenarioId">, reason: SkipReason): void {
    this.skipRow(this.rowOf(draft), reason);
  }

  private skipRow(row: RunScenario, reason: SkipReason): void {
    row.status = "skipped";
    row.skip_reason = reason;
    row.verdict = skippedVerdict(reason);
    row.duration_ms = 0;
    for (const attempt of row.attempts) {
      attempt.status = "skipped";
    }
    this.bumpCounters({ scenarios_done: 1, skipped: 1 });
    this.emit("scenario.finished", {
      run_scenario_id: row.id,
      status: "skipped",
      verdict: row.verdict,
      attempts: { passed: 0, failed: 0, total: row.attempts_total },
      duration_ms: 0,
    });
  }

  failInFlight(): void {
    for (const row of this.store.scenariosOfRun(this.run.id)) {
      if (row.status === "running") {
        this.endRow(row, "errored");
      } else if (row.status === "queued") {
        this.endRow(row, "canceled");
      }
    }
  }

  private endRow(row: RunScenario, status: "canceled" | "errored"): void {
    for (const key of [...this.openSessions.keys()]) {
      if (key.startsWith(`${row.id}:`)) {
        const attempt = Number(key.slice(row.id.length + 1));
        this.closeSession({ runScenarioId: row.id }, attempt);
      }
    }
    for (const attempt of row.attempts) {
      if (attempt.status === "running" || attempt.status === "queued") {
        attempt.status = status;
      }
    }
    const passed = row.attempts.filter((attempt) => attempt.verdict?.status === "pass").length;
    const failed = row.attempts.filter((attempt) => attempt.verdict?.status === "fail").length;
    const durationMs = Math.round(this.atMs - (this.startedAt.get(row.id) ?? this.atMs));
    row.status = status;
    row.duration_ms = durationMs;
    this.bumpCounters({ scenarios_done: 1 });
    this.emit("scenario.finished", {
      run_scenario_id: row.id,
      status,
      verdict: null,
      attempts: { passed, failed, total: row.attempts_total },
      duration_ms: durationMs,
    });
  }

  private sessionKey(runScenarioId: string, attempt: number): string {
    return `${runScenarioId}:${attempt}`;
  }

  private touchSessionUrl(runScenarioId: string, attempt: number, content: StepContent): void {
    const open = this.openSessions.get(this.sessionKey(runScenarioId, attempt));
    if (open === undefined || content.response?.kind !== "browser") {
      return;
    }
    open.session.last_url = content.response.url;
    if (open.frame !== null) {
      open.frame.pageUrl = content.response.url;
    }
  }

  private closeAllSessions(): void {
    for (const key of [...this.openSessions.keys()]) {
      const separator = key.lastIndexOf(":");
      this.closeSession(
        { runScenarioId: key.slice(0, separator) },
        Number(key.slice(separator + 1)),
      );
    }
  }

  private liveStreamers(): FrameStreamer[] {
    return [...this.state.frameStreamers].filter((streamer) => streamer.runId === this.run.id);
  }

  private attachFrameSession(session: BrowserSession): FrameSession | null {
    if (this.mode.kind !== "live") {
      return null;
    }
    const frame: FrameSession = {
      id: session.id,
      index: this.sessionOrdinal,
      title: session.scenario_title,
      active: true,
    };
    this.sessionOrdinal += 1;
    this.record.frameSessions ??= [];
    this.record.frameSessions.push(frame);
    this.record.framePoolSize = SIMULATION_FRAME_POOL;
    for (const streamer of this.liveStreamers()) {
      streamer.addSession(frame);
    }
    return frame;
  }

  private detachFrameSession(frame: FrameSession | null): void {
    if (frame === null) {
      return;
    }
    frame.active = false;
    for (const streamer of this.liveStreamers()) {
      streamer.removeSession(frame.id);
    }
  }

  private runStepHooks(step: Step, summary: StepSummary, attempt: number, rowId: string): void {
    if (extensions.stepRecordedHooks.size === 0) {
      return;
    }
    const context: StepRecordedContext = {
      run: this.run,
      runScenarioId: rowId,
      attempt,
      step,
      atMs: this.atMs,
      emit: (type, payload) => this.emit(type, payload),
      updateStep: (patch) => {
        Object.assign(step, patch);
        if (patch.verdict !== undefined) {
          summary.verdict = patch.verdict;
        }
        if (patch.cost_usd !== undefined) {
          summary.cost_usd = patch.cost_usd;
        }
      },
    };
    for (const hook of extensions.stepRecordedHooks) {
      hook(context);
    }
  }
}
