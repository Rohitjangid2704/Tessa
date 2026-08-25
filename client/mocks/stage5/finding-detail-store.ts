import type {
  ArtifactRef,
  Explanation,
  Finding,
  FindingOccurrence,
  FindingRepro,
  ReproTranscriptRow,
  RunScenario,
  Scenario,
} from "@/lib/api/types";
import type { ApiContext } from "../handlers/api";
import { runScenarioIdOf } from "../simulation/drafts";
import { mintArtifactRef } from "../stage2/artifacts";
import { stableHex, stableId, stableInt } from "../stage2/ids";
import { STAGE_TWO_IDS } from "../stage2/seed-ids";
import type { StageTwoStore } from "../stage2/store";
import { stageTwo } from "../stage2/support";
import { stageOne } from "../stage1/support";
import { buildSeededExplanations } from "./explanation-seed";
import type { FindingsStore } from "./findings-store";
import { findingsStore } from "./support";

export const MAX_ORACLE_ROWS = 20;
export const PROMOTED_TITLE_PREFIX = "Regression: ";

const DUPLICATE_ONE_IN = 5;
const NO_SEED_ONE_IN = 6;
const FALLBACK_CLOCK_AT = "2026-10-04T08:00:00.000Z";
const FALLBACK_SEED_VERSION = 3;

export class FindingDetailStore {
  private readonly explanations = new Map<string, Explanation[]>();

  private readonly findings: FindingsStore;

  constructor(findings: FindingsStore) {
    this.findings = findings;
    findings.onReset(() => this.explanations.clear());
  }

  explanationsOf(findingId: string, structuredEnabled: boolean): Explanation[] {
    const posted = this.explanations.get(findingId);
    if (posted !== undefined) {
      return [...posted];
    }
    const finding = this.findings.find(findingId);
    return finding === undefined ? [] : buildSeededExplanations(finding, structuredEnabled);
  }

  latestExplanationOf(finding: Finding, structuredEnabled: boolean): Explanation | null {
    return (
      finding.latest_explanation ??
      this.explanationsOf(finding.id, structuredEnabled).at(-1) ??
      null
    );
  }

  addExplanation(explanation: Explanation, structuredEnabled: boolean): void {
    this.explanations.set(explanation.finding_id, [
      ...this.explanationsOf(explanation.finding_id, structuredEnabled),
      explanation,
    ]);
  }
}

const detailStores = new WeakMap<FindingsStore, FindingDetailStore>();

export function findingDetailStore(context: ApiContext): FindingDetailStore {
  const findings = findingsStore(context);
  const existing = detailStores.get(findings);
  if (existing !== undefined) {
    return existing;
  }
  const created = new FindingDetailStore(findings);
  detailStores.set(findings, created);
  return created;
}

export interface ReproSource {
  runId: string;
  row: RunScenario | undefined;
}

function showcaseRow(store: StageTwoStore, scenarioId: string | null): RunScenario | undefined {
  const runId = STAGE_TWO_IDS.runs.showcase;
  const matching =
    scenarioId === null ? undefined : store.findRunScenario(runScenarioIdOf(runId, scenarioId));
  return matching ?? store.scenariosOfRun(runId)[0];
}

export function findReproSource(store: StageTwoStore, finding: Finding): ReproSource {
  const direct =
    finding.scenario_id === null
      ? undefined
      : store.findRunScenario(runScenarioIdOf(finding.last_seen_run_id, finding.scenario_id));
  if (direct !== undefined && direct.steps.length > 0) {
    return { runId: finding.last_seen_run_id, row: direct };
  }
  const fallback = showcaseRow(store, finding.scenario_id);
  if (fallback !== undefined) {
    return { runId: STAGE_TWO_IDS.runs.showcase, row: fallback };
  }
  return { runId: finding.last_seen_run_id, row: direct };
}

function failingAttempt(row: RunScenario): number {
  return row.attempts.find((attempt) => attempt.verdict?.status === "fail")?.attempt ?? 0;
}

function oracleRowsFor(finding: Finding): Record<string, unknown>[] {
  if (finding.class !== "wrong_result") {
    return [];
  }
  return Array.from({ length: Math.min(MAX_ORACLE_ROWS, 3) }, (_, index) => ({
    check: `${finding.invariant_id ?? "oracle"}_${index + 1}`,
    oracle_value: stableInt(3, 40, "oracle_value", finding.id, index),
    observed_value: stableInt(0, 40, "observed_value", finding.id, index),
    tenant: "gracie-demo",
  }));
}

function syntheticYaml(finding: Finding): string {
  return [
    "schema_version: 1",
    `title: ${JSON.stringify(finding.title)}`,
    "family: regression",
    "steps:",
    "  - adapter: http",
    "    label: GET /api/v1/issues",
    "    request: {method: GET, path: /api/v1/issues}",
    "    expect: {status: 200}",
    "",
  ].join("\n");
}

export function buildRepro(context: ApiContext, finding: Finding): FindingRepro {
  const store = stageTwo(context);
  const source = findReproSource(store, finding);
  const row = source.row;
  const attempt = row === undefined ? 0 : failingAttempt(row);
  const steps = row === undefined ? [] : store.stepsOfRunScenario(row.id, attempt);
  const transcript: ReproTranscriptRow[] = steps.map((step) => ({
    index: step.index,
    step_id: step.id,
    ask: step.ask,
    answer: step.answer,
    label: step.label,
  }));
  const mint = {
    key: context.state.config.wsTicketSigningKey,
    nowMs: Date.now(),
    expired: false,
  };
  const screencast: ArtifactRef[] = steps.flatMap((step) =>
    (store.findStep(step.id)?.defs ?? [])
      .filter((def) => def.kind === "recording")
      .map((def) => mintArtifactRef(def, mint)),
  );
  const session =
    row === undefined
      ? undefined
      : store.browserSessions.find(
          (candidate) => candidate.run_scenario_id === row.id && candidate.attempt === attempt,
        );
  const clock = store.findRun(source.runId)?.run.config_snapshot.clock ?? {
    mode: "pinned" as const,
    at: FALLBACK_CLOCK_AT,
  };
  const withoutSeed = stableInt(0, NO_SEED_ONE_IN - 1, "repro_seed", finding.id) === 0;
  return {
    finding_id: finding.id,
    run_id: source.runId,
    run_scenario_id: row?.id ?? runScenarioIdOf(source.runId, finding.scenario_id ?? finding.id),
    attempt,
    bundle_version: stageOne(context).latestBundle(finding.target_id)?.bundle.version ?? 1,
    scenario_id: finding.scenario_id ?? row?.scenario_id ?? stableId("scenario", finding.id),
    scenario_version: 1,
    scenario_yaml: row?.scenario_yaml ?? syntheticYaml(finding),
    seed: withoutSeed
      ? { version: null, hash: null }
      : {
          version: FALLBACK_SEED_VERSION,
          hash: stableHex(64, "repro_seed_hash", finding.target_id),
        },
    clock: { ...clock },
    browser_session_id: session?.id ?? null,
    transcript,
    screencast,
    expected: finding.expected,
    actual: finding.actual,
    oracle_rows: oracleRowsFor(finding),
    invariant_id: finding.invariant_id,
  };
}

function occurrenceTimes(finding: Finding): { first: number; last: number } {
  const first = Date.parse(finding.first_seen_at);
  const last = Date.parse(finding.last_seen_at);
  return { first, last: Math.max(first, last) };
}

export function buildOccurrences(
  context: ApiContext,
  record: { finding: Finding; runIds: string[] },
): FindingOccurrence[] {
  const { finding, runIds } = record;
  const twoStore = stageTwo(context);
  const showcaseRowForFinding = showcaseRow(twoStore, finding.scenario_id);
  const { first, last } = occurrenceTimes(finding);
  const count = Math.max(1, finding.occurrence_count);
  const peers = findingsStore(context).all.filter((candidate) => candidate.id !== finding.id);
  const duplicateOf =
    stableInt(0, DUPLICATE_ONE_IN - 1, "occurrence_duplicate", finding.id) === 0
      ? (peers[stableInt(0, Math.max(0, peers.length - 1), "duplicate_peer", finding.id)]?.id ??
        null)
      : null;
  return Array.from({ length: count }, (_, index) => {
    const runId = runIds[Math.floor((index * runIds.length) / count)] ?? finding.last_seen_run_id;
    const seenAt = count === 1 ? first : first + Math.round(((last - first) * index) / (count - 1));
    const row =
      runId === STAGE_TWO_IDS.runs.showcase
        ? showcaseRowForFinding
        : finding.scenario_id === null
          ? undefined
          : twoStore.findRunScenario(runScenarioIdOf(runId, finding.scenario_id));
    const attempt = row === undefined ? null : failingAttempt(row);
    const steps =
      row === undefined || attempt === null ? [] : twoStore.stepsOfRunScenario(row.id, attempt);
    const stepIndex = stableInt(
      0,
      Math.max(0, steps.length - 1),
      "occurrence_step",
      finding.id,
      index,
    );
    const step = steps[stepIndex];
    const evidence: Record<string, unknown> = {
      class: finding.class,
      message: `${finding.title} at attempt ${attempt ?? 0}`,
      expected: finding.expected,
      actual: finding.actual,
    };
    if (finding.invariant_id !== null) {
      evidence.invariant_id = finding.invariant_id;
    }
    if (index === 0 && duplicateOf !== null) {
      evidence.possible_duplicate_of = duplicateOf;
    }
    return {
      id: stableId("finding_occurrence", finding.id, index),
      finding_id: finding.id,
      run_id: runId,
      run_scenario_id: row?.id ?? null,
      step_id: step?.id ?? null,
      attempt,
      seen_at: new Date(seenAt).toISOString(),
      evidence,
    };
  });
}

export function buildPromotedScenario(
  context: ApiContext,
  finding: Finding,
  title: string | null,
): Scenario {
  const store = stageTwo(context);
  const source = finding.scenario_id === null ? undefined : store.findScenario(finding.scenario_id);
  const repro = buildRepro(context, finding);
  const latestBundle = stageOne(context).latestBundle(finding.target_id);
  const nowIso = new Date().toISOString();
  return {
    id: stableId("promoted_scenario", finding.id),
    target_id: finding.target_id,
    bundle_id:
      source?.scenario.bundle_id ??
      latestBundle?.bundle.id ??
      stableId("bundle", finding.target_id),
    feature_id: null,
    cell_id: null,
    title: title ?? `${PROMOTED_TITLE_PREFIX}${finding.title}`,
    family: source?.scenario.family ?? "regression",
    origin: "promoted_finding",
    status: "in_review",
    version: 1,
    yaml: repro.scenario_yaml,
    parsed: source === undefined ? {} : structuredClone(source.scenario.parsed),
    synthetic: false,
    validation: { valid: true, errors: [], warnings: [] },
    provenance: {
      source: "promoted_finding",
      finding_id: finding.id,
      run_id: repro.run_id,
    },
    created_at: nowIso,
    updated_at: nowIso,
  };
}
