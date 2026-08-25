import { stableId } from "../stage2/ids";
import { renderScenarioYaml, plusSeconds, type ScenarioStepDoc } from "../stage2/scenario-factory";
import type { ScenarioRecord } from "../stage2/types";
import type { MockState } from "../state";
import type { Depth, Scenario, ScenarioOrigin, ScenarioStatus } from "@/lib/api/types";
import { areaSlug, type CoverageCellState, type CoverageDataset } from "./coverage-data";
import { coverageStore } from "./coverage-store";

export type GenerationVariant = "paraphrase" | "negative" | "role_variant" | "adversarial";

const VARIANTS: readonly GenerationVariant[] = [
  "paraphrase",
  "negative",
  "role_variant",
  "adversarial",
];

const VARIANT_PREFIX: Record<GenerationVariant, string> = {
  paraphrase: "Paraphrase",
  negative: "Negative",
  role_variant: "Role variant",
  adversarial: "Adversarial",
};

const SCENARIO_TIMEOUT_SECONDS = 120;
const SEED_BASE_ISO = "2026-10-02T08:00:00.000Z";
const GENERATOR_MODEL = "gpt-5.1";
const GENERATOR_TEMPLATE_VERSION = 1;

export interface CellScenarioInput {
  dataset: CoverageDataset;
  cell: CoverageCellState;
  ordinal: number;
  origin: ScenarioOrigin;
  status: ScenarioStatus;
  variant: GenerationVariant | null;
  createdAt: string;
  runId: string | null;
  depth: Depth | null;
}

function stepOf(cell: CoverageCellState, prompt: string): ScenarioStepDoc {
  if (cell.interfaceKind === "browser") {
    return {
      label: "Open the app",
      adapter: "browser",
      action: "goto",
      url: "/",
      expect: { dom_state: { url: "/" }, console: { fail_on: ["error"] } },
    };
  }
  if (cell.interfaceKind === "sse") {
    return {
      label: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt,
      adapter: "sse",
      ask: prompt,
      request: { method: "POST", path: cell.basePath, body: { message: prompt } },
      expect: { status: 200, events: { include: ["done"] }, free_text: cell.title },
    };
  }
  return {
    label: `GET ${cell.basePath}`,
    adapter: "http",
    request: { method: "GET", path: cell.basePath },
    expect: { status: 200, internal_ids: true },
  };
}

export function buildCellScenario(input: CellScenarioInput): Scenario {
  const { dataset, cell, ordinal, origin, status, variant, createdAt, runId, depth } = input;
  const prefix = variant === null ? "Smoke" : VARIANT_PREFIX[variant];
  const title = `${prefix}: ${cell.title} (${cell.role}, ${cell.interfaceId})`;
  const family = areaSlug(cell.area);
  const doc = {
    schema_version: 1,
    title,
    feature_id: cell.featureId,
    family,
    role: cell.role,
    interface_id: cell.interfaceId,
    timeout_seconds: SCENARIO_TIMEOUT_SECONDS,
    cell: { role: cell.role, interface_id: cell.interfaceId },
    synthetic: false,
    steps: [stepOf(cell, variant === "negative" ? `${cell.title}, but as a stranger` : cell.title)],
  };
  const generated = origin === "generated";
  return {
    id: stableId("scenario_cov", cell.id, ordinal, runId ?? "seed"),
    target_id: dataset.targetId,
    bundle_id: dataset.bundleId,
    feature_id: cell.featureId,
    cell_id: cell.id,
    title,
    family,
    origin,
    status,
    version: 1,
    yaml: renderScenarioYaml(doc),
    parsed: JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    synthetic: false,
    validation: { valid: true, errors: [], warnings: [] },
    provenance: {
      source: origin,
      cell_id: cell.id,
      bundle_version: dataset.bundleVersion,
      generator: generated
        ? {
            model: GENERATOR_MODEL,
            effort: depth === "deep" ? "high" : "medium",
            template_version: GENERATOR_TEMPLATE_VERSION,
          }
        : null,
      generation_run_id: runId,
      dry_runs: [],
    },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function variantFor(index: number): GenerationVariant {
  return VARIANTS[index % VARIANTS.length] ?? "paraphrase";
}

export function registerScenario(state: MockState, scenario: Scenario): void {
  const entry: ScenarioRecord = { scenario, cellKey: null };
  state.stageTwo.addScenario(entry);
}

export function ensureCellScenarios(state: MockState, cellId: string): void {
  const located = coverageStore.findCell(cellId);
  if (located === undefined || located.cell.scenarioCount === 0) {
    return;
  }
  const { dataset, cell } = located;
  const known = state.stageTwo.scenarios.filter((entry) => entry.scenario.cell_id === cell.id);
  const covered = cell.status === "covered";
  for (let ordinal = known.length; ordinal < cell.scenarioCount; ordinal += 1) {
    const smoke = covered && ordinal === 0;
    const scenario = buildCellScenario({
      dataset,
      cell,
      ordinal,
      origin: smoke ? "bundle_example" : "generated",
      status: covered ? "accepted" : "in_review",
      variant: smoke ? null : variantFor(ordinal),
      createdAt: plusSeconds(SEED_BASE_ISO, ordinal * 60),
      runId: null,
      depth: null,
    });
    registerScenario(state, scenario);
  }
}
