import type {
  BrowserSession,
  Run,
  RunScenario,
  RunScenarioSummary,
  RunSummary,
  Scenario,
  ScenarioSummary,
  Step,
} from "@/lib/api/types";
import { mintArtifactRef } from "./artifacts";
import type { RunEntry } from "./store";
import type { StepRecord } from "./types";

export function toRunSummary(entry: RunEntry): RunSummary {
  const { run } = entry;
  return {
    id: run.id,
    kind: run.kind,
    target_id: run.target_id,
    plan_id: run.plan_id,
    run_group_id: run.run_group_id,
    status: run.status,
    counters: { ...run.counters },
    budget: { ...run.budget },
    read_only: run.read_only,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created_at: run.created_at,
  };
}

export function toRun(entry: RunEntry): Run {
  const { run } = entry;
  return {
    ...toRunSummary(entry),
    trigger: run.trigger,
    bundle_id: run.bundle_id,
    config_snapshot: {
      ...run.config_snapshot,
      scenario_versions: { ...run.config_snapshot.scenario_versions },
      models: { ...run.config_snapshot.models },
      prompt_template_versions: { ...run.config_snapshot.prompt_template_versions },
    },
    event_head_seq: entry.record.events.length,
    workflow_id: run.workflow_id,
    temporal_ui_url: run.temporal_ui_url,
    stop_requested_at: run.stop_requested_at,
    created_by: run.created_by,
  };
}

export function toRunScenarioSummary(row: RunScenario): RunScenarioSummary {
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    title: row.title,
    family: row.family,
    role: row.role,
    interface_id: row.interface_id,
    status: row.status,
    verdict: row.verdict === null ? null : { ...row.verdict },
    attempts_total: row.attempts_total,
    attempts_done: row.attempts_done,
    duration_ms: row.duration_ms,
  };
}

export function toRunScenario(row: RunScenario): RunScenario {
  return {
    ...toRunScenarioSummary(row),
    attempts: row.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      verdict: attempt.verdict === null ? null : { ...attempt.verdict },
    })),
    steps: row.steps.map((step) => ({
      ...step,
      verdict: step.verdict === null ? null : { ...step.verdict },
    })),
    scenario_yaml: row.scenario_yaml,
    skip_reason: row.skip_reason,
  };
}

export function toBrowserSession(session: BrowserSession): BrowserSession {
  return { ...session, viewport: { ...session.viewport } };
}

export function toScenarioSummary(scenario: Scenario): ScenarioSummary {
  return {
    id: scenario.id,
    target_id: scenario.target_id,
    bundle_id: scenario.bundle_id,
    feature_id: scenario.feature_id,
    cell_id: scenario.cell_id,
    title: scenario.title,
    family: scenario.family,
    origin: scenario.origin,
    status: scenario.status,
    version: scenario.version,
    synthetic: scenario.synthetic,
    validation: structuredClone(scenario.validation),
    provenance: scenario.provenance === null ? null : { ...scenario.provenance },
    created_at: scenario.created_at,
    updated_at: scenario.updated_at,
  };
}

export function toScenario(scenario: Scenario): Scenario {
  return structuredClone(scenario);
}

export interface StepMintOptions {
  key: string;
  nowMs: number;
  expired: boolean;
}

export function toStep(record: StepRecord, options: StepMintOptions): Step {
  const copy = structuredClone(record.step);
  copy.artifacts = record.defs.map((def) => mintArtifactRef(def, options));
  return copy;
}
