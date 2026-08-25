import { stableId } from "../stage2/ids";
import { plusSeconds, renderScenarioYaml } from "../stage2/scenario-factory";
import type { StageTwoStore } from "../stage2/store";
import type { ScenarioRecord } from "../stage2/types";
import type { MockState } from "../state";
import type { Effort, ScenarioDryRun, ScenarioProvenance, ScenarioVersion } from "@/lib/api/types";
import { GENERATOR, seededProvenanceOf, TICKET_URL } from "./review-queue";

type JsonRecord = Record<string, unknown>;

const VERSION_STEP_SECONDS = 1800;
const DEFAULT_TIMEOUT_SECONDS = 120;
const TIMEOUT_STEP_SECONDS = 30;
const MIN_TIMEOUT_SECONDS = 30;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDoc(parsed: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(parsed)) as JsonRecord;
}

function earlierVersion(entry: ScenarioRecord, version: number): ScenarioVersion {
  const { scenario } = entry;
  const stepsBack = scenario.version - version;
  const doc = cloneDoc(scenario.parsed);
  const timeout = typeof doc.timeout_seconds === "number" ? doc.timeout_seconds : DEFAULT_TIMEOUT_SECONDS;
  doc.timeout_seconds = Math.max(MIN_TIMEOUT_SECONDS, timeout - stepsBack * TIMEOUT_STEP_SECONDS);
  const createdAt = plusSeconds(scenario.created_at, (version - 1) * VERSION_STEP_SECONDS);
  return {
    scenario_id: scenario.id,
    version,
    yaml: renderScenarioYaml(doc),
    parsed: doc,
    created_by: null,
    created_at: createdAt,
    note: version === 1 ? "Created" : null,
  };
}

function currentVersion(entry: ScenarioRecord): ScenarioVersion {
  const { scenario } = entry;
  return {
    scenario_id: scenario.id,
    version: scenario.version,
    yaml: scenario.yaml,
    parsed: cloneDoc(scenario.parsed),
    created_by: null,
    created_at: scenario.updated_at,
    note: scenario.version === 1 ? "Created" : null,
  };
}

function legacyPart(source: JsonRecord | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

const EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high"];

function isGenerated(entry: ScenarioRecord): boolean {
  return entry.scenario.origin === "generated" && !entry.scenario.synthetic;
}

function generatorFromLegacy(
  entry: ScenarioRecord,
  legacy: JsonRecord | null,
): ScenarioProvenance["generator"] {
  const candidate = legacy?.generator;
  if (isRecord(candidate) && typeof candidate.model === "string") {
    const effort = EFFORTS.find((option) => option === candidate.effort) ?? GENERATOR.effort;
    const templateVersion =
      typeof candidate.template_version === "number"
        ? candidate.template_version
        : GENERATOR.template_version;
    return { model: candidate.model, effort, template_version: templateVersion };
  }
  return isGenerated(entry) ? { ...GENERATOR } : null;
}

function passingDryRuns(runId: string, scenarioId: string): ScenarioDryRun[] {
  return [0, 1].map((index): ScenarioDryRun => ({
    run_id: runId,
    run_scenario_id: stableId("dry_run_scenario", scenarioId, index),
    verdict: {
      status: "pass",
      tier: "code",
      confidence: null,
      reason: null,
      reason_code: null,
      skip_reason: null,
    },
  }));
}

function dryRunsFromLegacy(entry: ScenarioRecord, legacy: JsonRecord | null): ScenarioDryRun[] {
  const recorded = legacy?.dry_runs;
  if (Array.isArray(recorded) && recorded.length > 0) {
    return structuredClone(recorded as ScenarioDryRun[]);
  }
  const generationRun = legacyPart(legacy, "generation_run_id");
  if (generationRun !== null && isGenerated(entry)) {
    return passingDryRuns(generationRun, entry.scenario.id);
  }
  return [];
}

export class ScenarioEditStore {
  private readonly state: MockState;
  private versions = new Map<string, ScenarioVersion[]>();
  private reviews = new Map<string, JsonRecord>();

  constructor(state: MockState) {
    this.state = state;
  }

  reset(): void {
    this.versions = new Map();
    this.reviews = new Map();
  }

  versionsOf(entry: ScenarioRecord): ScenarioVersion[] {
    const existing = this.versions.get(entry.scenario.id);
    if (existing !== undefined) {
      return existing;
    }
    const history: ScenarioVersion[] = [];
    for (let version = 1; version < entry.scenario.version; version += 1) {
      history.push(earlierVersion(entry, version));
    }
    history.push(currentVersion(entry));
    this.versions.set(entry.scenario.id, history);
    return history;
  }

  appendVersion(entry: ScenarioRecord, createdBy: string, createdAt: string): ScenarioVersion {
    const history = this.versionsOf(entry);
    const added: ScenarioVersion = {
      scenario_id: entry.scenario.id,
      version: entry.scenario.version,
      yaml: entry.scenario.yaml,
      parsed: cloneDoc(entry.scenario.parsed),
      created_by: createdBy,
      created_at: createdAt,
      note: null,
    };
    if (history.at(-1)?.version === added.version) {
      history[history.length - 1] = added;
    } else {
      history.push(added);
    }
    return added;
  }

  startHistory(entry: ScenarioRecord, createdBy: string): void {
    this.versions.set(entry.scenario.id, [
      {
        scenario_id: entry.scenario.id,
        version: 1,
        yaml: entry.scenario.yaml,
        parsed: cloneDoc(entry.scenario.parsed),
        created_by: createdBy,
        created_at: entry.scenario.created_at,
        note: "Created",
      },
    ]);
  }

  recordReview(scenarioId: string, review: JsonRecord): void {
    this.reviews.set(scenarioId, review);
  }

  reviewOf(scenarioId: string): JsonRecord | undefined {
    return this.reviews.get(scenarioId);
  }

  provenanceOf(entry: ScenarioRecord): ScenarioProvenance {
    const { scenario } = entry;
    const legacy = isRecord(scenario.provenance) ? scenario.provenance : null;
    const bundle = this.state.stageOne.findBundle(scenario.bundle_id)?.bundle;
    const bundleVersion =
      bundle?.version ??
      (typeof legacy?.bundle_version === "number" ? legacy.bundle_version : 1);
    const base: ScenarioProvenance = {
      bundle_id: scenario.bundle_id,
      bundle_version: bundleVersion,
      cell_id: scenario.cell_id,
      created_at: scenario.created_at,
      dry_runs: dryRunsFromLegacy(entry, legacy),
      finding_id: legacyPart(legacy, "finding_id"),
      generator: generatorFromLegacy(entry, legacy),
      prompt_issue_id:
        scenario.origin === "authored" ? stableId("prompt_issue", "author", scenario.id) : null,
      replay_id:
        legacyPart(legacy, "replay_id") ??
        (scenario.origin === "replay" ? stableId("replay", "provenance", scenario.id) : null),
      ticket_url: scenario.origin === "promoted_finding" ? TICKET_URL : null,
    };
    return { ...base, ...seededProvenanceOf(scenario.id) };
  }
}

const stores = new WeakMap<StageTwoStore, ScenarioEditStore>();

export function scenarioEdits(state: MockState): ScenarioEditStore {
  const existing = stores.get(state.stageTwo);
  if (existing !== undefined) {
    return existing;
  }
  const created = new ScenarioEditStore(state);
  state.stageTwo.onReset(() => created.reset());
  stores.set(state.stageTwo, created);
  return created;
}
