import type { InterimSchemas, Schemas } from "@/lib/api/types";
import { formatDuration } from "@/lib/format-duration";
import { formatUsd } from "@/lib/format-usd";
import type { KnownStreamEvent } from "./events";

export type EventTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface EventDescription {
  title: string;
  detail: string | null;
  tone: EventTone;
}

const HASH_PREVIEW_LENGTH = 12;

function unreachable(event: never): never {
  throw new Error(`unhandled event ${JSON.stringify(event)}`);
}

function attemptLabel(attempt: number): string {
  return `attempt ${attempt + 1}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function verdictTone(status: Schemas["VerdictStatus"]): EventTone {
  switch (status) {
    case "pass":
      return "success";
    case "fail":
      return "danger";
    case "flaky":
    case "uncertain":
      return "warning";
    case "skipped":
      return "neutral";
  }
}

function runStatusTone(status: Schemas["RunStatus"]): EventTone {
  switch (status) {
    case "failed":
    case "budget_exceeded":
      return "danger";
    case "canceled":
    case "canceling":
      return "warning";
    default:
      return "neutral";
  }
}

function describeVerdict(verdict: Schemas["Verdict"]): string {
  const parts: string[] = [verdict.tier];
  if (verdict.confidence !== null) {
    parts.push(`${Math.round(verdict.confidence * 100)}% confidence`);
  }
  if (verdict.skip_reason !== null) {
    parts.push(verdict.skip_reason);
  }
  return parts.join(", ");
}

function severityTone(severity: InterimSchemas["Severity"]): EventTone {
  switch (severity) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
    case "info":
      return "info";
  }
}

function scenarioStatusTone(status: Schemas["ScenarioStatus"]): EventTone {
  switch (status) {
    case "accepted":
      return "success";
    case "invalid":
    case "rejected":
      return "danger";
    case "quarantined":
      return "warning";
    case "in_review":
    case "validating":
      return "info";
    case "draft":
    case "retired":
      return "neutral";
  }
}

function attackOutcomeTone(outcome: InterimSchemas["AttackOutcome"]): EventTone {
  switch (outcome) {
    case "blocked":
      return "success";
    case "breached":
      return "danger";
    case "inconclusive":
      return "warning";
  }
}

function mutationOutcomeTone(outcome: InterimSchemas["MutationOutcome"]): EventTone {
  switch (outcome) {
    case "killed":
      return "success";
    case "survived":
      return "warning";
    case "errored":
      return "danger";
    case "skipped":
      return "neutral";
  }
}

function describeExploreAction(payload: InterimSchemas["ExploreActionPayload"]): string {
  const where: string[] = [];
  if (payload.target !== null) {
    where.push(payload.target);
  }
  if (payload.url !== null) {
    where.push(payload.url);
  }
  if (payload.text !== null) {
    where.push(`"${payload.text}"`);
  }
  return where.length === 0 ? payload.rationale : `${where.join(" ")}: ${payload.rationale}`;
}

function describeSimChecks(checks: InterimSchemas["SimChecks"]): string {
  return `end state ${checks.end_state}, calls ${checks.calls}, invariants ${checks.invariants}, goal ${checks.goal}, dialogue ${checks.dialogue}`;
}

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "none";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function describeFindingChanges(
  changes: InterimSchemas["FindingUpdatedPayload"]["changes"],
): string {
  const entries = Object.entries(changes);
  if (entries.length === 0) {
    return "no field changes";
  }
  return entries
    .map(
      ([field, change]) =>
        `${field} ${formatChangeValue(change.from)} to ${formatChangeValue(change.to)}`,
    )
    .join(", ");
}

function describeInvariantResult(payload: InterimSchemas["InvariantResultPayload"]): string {
  const parts: string[] = [payload.pack, payload.tier];
  if (payload.attempt !== null) {
    parts.push(attemptLabel(payload.attempt));
  }
  if (payload.skip_reason !== null) {
    parts.push(payload.skip_reason);
  }
  return `${parts.join(", ")}: ${payload.message}`;
}

function previewHash(hash: string | null): string {
  return hash === null ? "none" : hash.slice(0, HASH_PREVIEW_LENGTH);
}

function describeSeedHashes(payload: Schemas["SeedProgressPayload"]): string | null {
  if (payload.observed_hash === null && payload.expected_hash === null) {
    return null;
  }
  return `observed ${previewHash(payload.observed_hash)}, expected ${previewHash(payload.expected_hash)}`;
}

function describeStepOutcome(payload: Schemas["StepRecordedPayload"]): string {
  const outcome = payload.ok === null ? "no result" : payload.ok ? "ok" : "failed";
  const failures =
    payload.tier0_failure_count > 0
      ? `, ${plural(payload.tier0_failure_count, "tier 0 failure")}`
      : "";
  return `${payload.label} (${payload.adapter}, ${outcome}, ${payload.latency_ms} ms${failures})`;
}

function stepRecordedTone(payload: Schemas["StepRecordedPayload"]): EventTone {
  if (payload.ok === false) {
    return "danger";
  }
  return payload.tier0_failure_count > 0 ? "warning" : "neutral";
}

function scenarioFinishedTone(payload: Schemas["ScenarioFinishedPayload"]): EventTone {
  if (payload.verdict !== null) {
    return verdictTone(payload.verdict.status);
  }
  switch (payload.status) {
    case "errored":
      return "danger";
    case "canceled":
      return "warning";
    default:
      return "neutral";
  }
}

export function describeEvent(event: KnownStreamEvent): EventDescription {
  switch (event.type) {
    case "stream.hello":
      return {
        title: "Stream connected",
        detail:
          event.payload.resumed_from === null
            ? `head seq ${event.payload.head_seq ?? "n/a"}`
            : `resumed from seq ${event.payload.resumed_from}`,
        tone: "info",
      };
    case "stream.replay_end":
      return {
        title: "Replay finished",
        detail: `through seq ${event.payload.through_seq}`,
        tone: "info",
      };
    case "stream.resync_required":
      return {
        title: "Resync required",
        detail: `${event.payload.reason}, log starts at seq ${event.payload.min_seq}`,
        tone: "warning",
      };
    case "stream.heartbeat":
      return { title: "Heartbeat", detail: null, tone: "neutral" };
    case "stream.closing":
      return { title: "Stream closing", detail: event.payload.reason, tone: "warning" };
    case "stream.error":
      return {
        title: "Stream error",
        detail: `${event.payload.code}: ${event.payload.message}`,
        tone: "danger",
      };
    case "run.created":
      return {
        title: "Run created",
        detail: `${event.payload.kind} run, status ${event.payload.status}`,
        tone: "neutral",
      };
    case "run.status_changed":
      return {
        title: "Status changed",
        detail: `${event.payload.previous} to ${event.payload.status}`,
        tone: "info",
      };
    case "hello.tick":
      return {
        title: `Tick ${event.payload.n} of ${event.payload.total}`,
        detail: event.payload.message,
        tone: "neutral",
      };
    case "hello.laya":
      return event.payload.ok
        ? {
            title: "Laya smoke call succeeded",
            detail: `${event.payload.latency_ms} ms, HTTP ${event.payload.status_code ?? "n/a"}`,
            tone: "success",
          }
        : {
            title: "Laya smoke call failed",
            detail: event.payload.error ?? `${event.payload.latency_ms} ms`,
            tone: "danger",
          };
    case "run.finished":
      return {
        title: "Run finished",
        detail: `${event.payload.status} in ${event.payload.duration_ms} ms`,
        tone: runStatusTone(event.payload.status),
      };
    case "run.progress":
      return {
        title: "Progress",
        detail: `${event.payload.scenarios_done} of ${plural(event.payload.scenarios_total, "scenario")} done: ${event.payload.pass} pass, ${event.payload.fail} fail, ${event.payload.flaky} flaky, ${event.payload.uncertain} uncertain, ${event.payload.skipped} skipped`,
        tone: "neutral",
      };
    case "budget.updated":
      return {
        title: "Budget updated",
        detail: `${formatUsd(event.payload.spent_usd)} of ${formatUsd(event.payload.max_usd)}, ${formatDuration(event.payload.elapsed_ms)} of ${event.payload.max_minutes} min`,
        tone: "neutral",
      };
    case "budget.exhausted":
      return {
        title: "Budget exhausted",
        detail:
          event.payload.dimension === "usd"
            ? `cost limit ${formatUsd(event.payload.limit)}, reached ${formatUsd(event.payload.actual)}`
            : `time limit ${event.payload.limit} min, reached ${event.payload.actual} min`,
        tone: "danger",
      };
    case "scenario.queued":
      return {
        title: "Scenario queued",
        detail: `${event.payload.title} (${event.payload.role} on ${event.payload.interface_id}), ${plural(event.payload.attempts_total, "attempt")}`,
        tone: "neutral",
      };
    case "scenario.started":
      return {
        title: "Scenario started",
        detail: attemptLabel(event.payload.attempt),
        tone: "info",
      };
    case "scenario.verdict":
      return {
        title: `Verdict ${event.payload.verdict.status}`,
        detail: `${attemptLabel(event.payload.attempt)}, ${describeVerdict(event.payload.verdict)}`,
        tone: verdictTone(event.payload.verdict.status),
      };
    case "scenario.finished":
      return {
        title: `Scenario ${event.payload.status}`,
        detail: `${event.payload.verdict === null ? "" : `verdict ${event.payload.verdict.status}, `}${event.payload.attempts.passed} of ${plural(event.payload.attempts.total, "attempt")} passed, ${event.payload.duration_ms} ms`,
        tone: scenarioFinishedTone(event.payload),
      };
    case "step.recorded":
      return {
        title: `Step ${event.payload.index} recorded`,
        detail: `${attemptLabel(event.payload.attempt)}, ${describeStepOutcome(event.payload)}`,
        tone: stepRecordedTone(event.payload),
      };
    case "step.graded":
      return {
        title: `Step graded ${event.payload.verdict.status}`,
        detail:
          event.payload.escalated_to === null
            ? describeVerdict(event.payload.verdict)
            : `${describeVerdict(event.payload.verdict)}, escalated to ${event.payload.escalated_to}`,
        tone: verdictTone(event.payload.verdict.status),
      };
    case "seed.progress":
      return {
        title: `Seed ${event.payload.phase} ${event.payload.status}`,
        detail: describeSeedHashes(event.payload),
        tone:
          event.payload.status === "failed"
            ? "danger"
            : event.payload.status === "ok"
              ? "success"
              : "info",
      };
    case "invariant.result":
      return {
        title: `Invariant ${event.payload.invariant_id} ${event.payload.status}`,
        detail: describeInvariantResult(event.payload),
        tone: verdictTone(event.payload.status),
      };
    case "finding.created":
      return {
        title: event.payload.is_new ? "Finding created" : "Finding seen again",
        detail: `${event.payload.severity} ${event.payload.class}: ${event.payload.title}`,
        tone: severityTone(event.payload.severity),
      };
    case "finding.updated":
      return {
        title: "Finding updated",
        detail: describeFindingChanges(event.payload.changes),
        tone: "info",
      };
    case "finding.occurrence_added":
      return {
        title: "Occurrence added",
        detail: `${plural(event.payload.occurrence_count, "occurrence")} in total`,
        tone: "neutral",
      };
    case "scenario.changed":
      return {
        title: `Scenario ${event.payload.status}`,
        detail:
          event.payload.cell_id === null
            ? `scenario ${event.payload.scenario_id}`
            : `scenario ${event.payload.scenario_id} in cell ${event.payload.cell_id}`,
        tone: scenarioStatusTone(event.payload.status),
      };
    case "coverage.updated":
      return {
        title: "Coverage updated",
        detail: `${plural(event.payload.cell_ids.length, "cell")} ${event.payload.reason}`,
        tone: "info",
      };
    case "proposal.updated":
      return {
        title: "Proposal updated",
        detail:
          event.payload.item_id === null
            ? "a new proposal was stored"
            : `item ${event.payload.item_id} is ${event.payload.status ?? "changed"}`,
        tone: "info",
      };
    case "agent_session.changed":
      return {
        title: event.payload.active ? "Claude Code session active" : "Claude Code session ended",
        detail: `session ${event.payload.agent_session_id}`,
        tone: "info",
      };
    case "generation.progress":
      return {
        title: "Generation progress",
        detail: `${event.payload.cells_done} of ${plural(event.payload.cells_total, "cell")} done, ${event.payload.scenarios_created} created, ${event.payload.scenarios_invalid} invalid`,
        tone: event.payload.scenarios_invalid > 0 ? "warning" : "info",
      };
    case "explore.action":
      return {
        title: `Action ${event.payload.index}: ${event.payload.action}`,
        detail: describeExploreAction(event.payload),
        tone: "neutral",
      };
    case "explore.candidate":
      return {
        title: "Possible issue found",
        detail: `${event.payload.description} (steps ${event.payload.from_index} to ${event.payload.to_index}), verifying`,
        tone: "warning",
      };
    case "explore.verified":
      return event.payload.verified
        ? {
            title: "Candidate verified",
            detail:
              event.payload.finding_id === null
                ? "no finding linked"
                : `finding ${event.payload.finding_id}`,
            tone: "warning",
          }
        : { title: "Candidate not reproduced", detail: null, tone: "neutral" };
    case "sim.turn":
      return {
        title: `Turn ${event.payload.turn} by ${event.payload.speaker}`,
        detail: event.payload.text_preview,
        tone: "neutral",
      };
    case "sim.checked":
      return {
        title: `Simulation checked ${event.payload.verdict.status}`,
        detail: describeSimChecks(event.payload.checks),
        tone: verdictTone(event.payload.verdict.status),
      };
    case "redteam.round_started":
      return {
        title: `Round ${event.payload.index} started`,
        detail: event.payload.family,
        tone: "info",
      };
    case "redteam.attack":
      return {
        title: `Attack ${event.payload.outcome}`,
        detail: event.payload.family,
        tone: attackOutcomeTone(event.payload.outcome),
      };
    case "redteam.round_finished":
      return {
        title: `Round ${event.payload.index} finished${event.payload.dry ? " (dry)" : ""}`,
        detail: `${plural(event.payload.attacks, "attack")}, ${plural(event.payload.candidates, "candidate")}`,
        tone: "neutral",
      };
    case "replay.progress":
      return {
        title: "Replay progress",
        detail: `${event.payload.cases_created} created, ${event.payload.cases_rejected} rejected of ${plural(event.payload.records_total, "record")}`,
        tone: "info",
      };
    case "run.stop_requested":
      return {
        title: "Stop requested",
        detail: `requested by ${event.payload.requested_by}`,
        tone: "warning",
      };
    case "mutation.outcome":
      return {
        title: `Mutant ${event.payload.outcome} on ${event.payload.invariant_id}`,
        detail:
          event.payload.caught_by.length === 0
            ? "no scenario caught it"
            : `caught by ${plural(event.payload.caught_by.length, "scenario")}`,
        tone: mutationOutcomeTone(event.payload.outcome),
      };
    case "notification.created":
      return {
        title: event.payload.title,
        detail: `${event.payload.kind}, ${event.payload.severity}`,
        tone: severityTone(event.payload.severity),
      };
    case "dashboard.invalidate":
      return { title: "Dashboard invalidated", detail: null, tone: "neutral" };
    case "contract.progress":
      return {
        title: "Contract check progress",
        detail: `${event.payload.items_done} of ${plural(event.payload.items_total, "item")} compared, ${event.payload.breaking} breaking`,
        tone: event.payload.breaking > 0 ? "danger" : "info",
      };
    case "browser_session.started":
      return {
        title: "Browser session started",
        detail: event.payload.scenario_title,
        tone: "neutral",
      };
    case "browser_session.ended":
      return {
        title: "Browser session ended",
        detail: `${event.payload.has_recording ? "recording saved" : "no recording"}, ${event.payload.has_trace ? "trace saved" : "no trace"}`,
        tone: "neutral",
      };
    case "tile.frame":
      return {
        title: "Frame",
        detail: `session ${event.payload.browser_session_id}, frame ${event.payload.frame_seq}`,
        tone: "neutral",
      };
    default:
      return unreachable(event);
  }
}
