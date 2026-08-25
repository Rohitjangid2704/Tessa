import type { CatalogItem } from "../factories/catalog";
import { isWriteFeature } from "../stage2/expand";
import { stableId, stableUnit } from "../stage2/ids";
import type { ScenarioDoc, ScenarioStepDoc } from "../stage2/scenario-factory";
import type { Scenario, SkipReason } from "@/lib/api/types";
import { buildStepContent, type StepContent } from "./step-content";

export const SMOKE_FAIL_RATE = 0.1;
export const NATURAL_FLAKE_RATE = 0.03;
export const DISABLED_FLAGS: readonly string[] = ["ESCALATION_SWEEP_ENABLED"];

export type AttemptOutcome = "pass" | "fail";

export interface AttemptDraft {
  outcome: AttemptOutcome;
  steps: StepContent[];
  browser: boolean;
  lastUrl: string | null;
}

export interface ScenarioDraft {
  runScenarioId: string;
  scenario: Scenario;
  role: string;
  interfaceId: string;
  family: string;
  title: string;
  skip: SkipReason | null;
  attemptsTotal: number;
  attempts: AttemptDraft[];
}

export interface DraftEnvironment {
  baseUrlOf: (interfaceId: string) => string;
  failedInterfaces: ReadonlySet<string>;
}

export interface DraftOptions {
  runId: string;
  attempts: number;
  seed: number;
  verdictFlaky: boolean;
  readOnly: boolean;
  environment: DraftEnvironment;
}

export interface DraftSource {
  scenario: Scenario;
  feature: CatalogItem | null;
  interfaceKind: string;
  productionBlocked: boolean;
  outcomes?: AttemptOutcome[];
}

export function runScenarioIdOf(runId: string, scenarioId: string): string {
  return stableId("run_scenario", runId, scenarioId);
}

export function decideOutcomes(
  seed: number,
  scenarioId: string,
  attempts: number,
  verdictFlaky: boolean,
): AttemptOutcome[] {
  if (verdictFlaky && attempts >= 2 && stableUnit(seed, scenarioId, "flaky") < 0.5) {
    return Array.from({ length: attempts }, (_, index) => (index % 2 === 0 ? "fail" : "pass"));
  }
  const consistentlyFailing = stableUnit(seed, scenarioId, "base") < SMOKE_FAIL_RATE;
  return Array.from({ length: attempts }, (_, index) =>
    consistentlyFailing || stableUnit(seed, scenarioId, "attempt", index) < NATURAL_FLAKE_RATE
      ? "fail"
      : "pass",
  );
}

export function decideSkip(
  source: DraftSource,
  options: Pick<DraftOptions, "readOnly" | "environment">,
): SkipReason | null {
  const { feature } = source;
  if (
    source.productionBlocked ||
    (options.readOnly && feature !== null && isWriteFeature(feature))
  ) {
    return "production_blocked";
  }
  if (!["http", "sse", "browser"].includes(source.interfaceKind)) {
    return "adapter_unsupported";
  }
  if (feature !== null && DISABLED_FLAGS.includes(feature.flag)) {
    return "flag_disabled";
  }
  if (options.environment.failedInterfaces.has(source.scenario.parsed.interface_id as string)) {
    return "service_down";
  }
  return null;
}

function stepDocsOf(scenario: Scenario): ScenarioStepDoc[] {
  const doc = scenario.parsed as Partial<ScenarioDoc>;
  return Array.isArray(doc.steps) ? doc.steps : [];
}

function buildAttempt(
  source: DraftSource,
  options: DraftOptions,
  attempt: number,
  outcome: AttemptOutcome,
): AttemptDraft {
  const { scenario, feature } = source;
  const docs = stepDocsOf(scenario);
  const interfaceId = String(scenario.parsed.interface_id ?? "");
  const role = String(scenario.parsed.role ?? "");
  const browser = source.interfaceKind === "browser";
  const steps = docs.map((doc, index) =>
    buildStepContent({
      doc,
      feature,
      role,
      interfaceId,
      baseUrl: options.environment.baseUrlOf(interfaceId),
      seed: `${scenario.id}:${attempt}:${index}`,
      failing: outcome === "fail" && index === docs.length - 1,
      recordingAndTrace: browser,
    }),
  );
  const lastBrowser = [...steps].reverse().find((step) => step.adapter === "browser");
  const lastUrl = lastBrowser?.response?.kind === "browser" ? lastBrowser.response.url : null;
  return { outcome, steps, browser, lastUrl };
}

export function buildScenarioDraft(source: DraftSource, options: DraftOptions): ScenarioDraft {
  const { scenario } = source;
  const skip = decideSkip(source, options);
  const outcomes =
    source.outcomes ??
    decideOutcomes(options.seed, scenario.id, options.attempts, options.verdictFlaky);
  return {
    runScenarioId: runScenarioIdOf(options.runId, scenario.id),
    scenario,
    role: String(scenario.parsed.role ?? ""),
    interfaceId: String(scenario.parsed.interface_id ?? ""),
    family: scenario.family,
    title: scenario.title,
    skip,
    attemptsTotal: options.attempts,
    attempts:
      skip === null
        ? outcomes.map((outcome, attempt) => buildAttempt(source, options, attempt, outcome))
        : [],
  };
}
