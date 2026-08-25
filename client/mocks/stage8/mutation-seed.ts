import { MEMBER_USER } from "../factories/users";
import { launchRun } from "../server/run-simulator";
import { STAGE_ONE_IDS } from "../stage1/seed";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { stableId } from "../stage2/ids";
import { buildConfigSnapshot } from "../stage2/plan-service";
import { STAGE_TWO_IDS } from "../stage2/seed-ids";
import type { StageTwoStore } from "../stage2/store";
import { mockState, type MockState } from "../state";
import "../streams/mutation-script";
import type { Budget, Mutant, MutationOutcome } from "@/lib/api/types";
import type { MutationScenario } from "./mutation-fixture";
import { planOutcomes } from "./mutation-plan";
import { mutationStore, type SeededOutcomes } from "./mutation-store";

interface SeededMutant {
  name: string;
  branch: string;
  description: string;
  expectedCatchers: readonly string[];
  outcomes: SeededOutcomes | null;
  baseUrl: string | null;
  createdAt: string;
  runAt: string | null;
}

const SEEDED_BUDGET: Budget = { max_usd: 2, max_minutes: 20 };

export const SURVIVOR_MUTANT_NAME = "skip-tenant-filter-on-issue-list";
export const UNDEPLOYED_MUTANT_NAME = "strip-pii-mask-on-guest-export";

const KILLED: MutationOutcome = "killed";
const SURVIVED: MutationOutcome = "survived";

const SEEDED_MUTANTS: readonly SeededMutant[] = [
  {
    name: SURVIVOR_MUTANT_NAME,
    branch: `mutant/${SURVIVOR_MUTANT_NAME}`,
    description:
      "The open issue list drops its tenant filter, so a manager sees issues of every property.",
    expectedCatchers: ["tenant_isolation", "count_consistency"],
    outcomes: { tenant_isolation: SURVIVED, count_consistency: SURVIVED },
    baseUrl: "https://gracie-m1.qa.example.test",
    createdAt: "2026-10-02T09:00:00.000Z",
    runAt: "2026-10-05T07:30:00.000Z",
  },
  {
    name: "drop-tenant-filter-on-requests",
    branch: "mutant/drop-tenant-filter-on-requests",
    description: "Guest requests are listed without the tenant filter.",
    expectedCatchers: ["tenant_isolation", "count_consistency"],
    outcomes: { tenant_isolation: KILLED, count_consistency: KILLED },
    baseUrl: "https://gracie-m2.qa.example.test",
    createdAt: "2026-10-02T09:10:00.000Z",
    runAt: "2026-10-04T01:00:00.000Z",
  },
  {
    name: "leak-other-tenant-through-export",
    branch: "mutant/leak-other-tenant-through-export",
    description: "The CSV export ignores the signed-in tenant and exports every tenant.",
    expectedCatchers: ["tenant_isolation", "auth_boundaries"],
    outcomes: { tenant_isolation: KILLED, auth_boundaries: KILLED },
    baseUrl: "https://gracie-m3.qa.example.test",
    createdAt: "2026-10-02T09:20:00.000Z",
    runAt: "2026-10-04T01:15:00.000Z",
  },
  {
    name: "off-by-one-open-issue-count",
    branch: "mutant/off-by-one-open-issue-count",
    description: "The dashboard open issue counter reports one more than the list shows.",
    expectedCatchers: ["count_consistency", "gracie_open_issue_counts"],
    outcomes: { count_consistency: KILLED, gracie_open_issue_counts: KILLED },
    baseUrl: "https://gracie-m4.qa.example.test",
    createdAt: "2026-10-02T09:30:00.000Z",
    runAt: "2026-10-04T01:30:00.000Z",
  },
  {
    name: "stale-count-after-close",
    branch: "mutant/stale-count-after-close",
    description: "Closing an issue does not update the cached open count until the next hour.",
    expectedCatchers: ["count_consistency"],
    outcomes: { count_consistency: KILLED },
    baseUrl: "https://gracie-m5.qa.example.test",
    createdAt: "2026-10-02T09:40:00.000Z",
    runAt: "2026-10-04T01:45:00.000Z",
  },
  {
    name: "guest-reads-staff-notes",
    branch: "mutant/guest-reads-staff-notes",
    description: "The guest request detail includes the internal staff notes field.",
    expectedCatchers: ["pii_by_role", "auth_boundaries"],
    outcomes: { pii_by_role: KILLED, auth_boundaries: KILLED },
    baseUrl: "https://gracie-m6.qa.example.test",
    createdAt: "2026-10-02T09:50:00.000Z",
    runAt: "2026-10-04T02:00:00.000Z",
  },
  {
    name: "show-guest-phone-to-front-desk",
    branch: "mutant/show-guest-phone-to-front-desk",
    description: "The front desk view stops masking the guest phone number.",
    expectedCatchers: ["pii_by_role"],
    outcomes: { pii_by_role: KILLED },
    baseUrl: "https://gracie-m7.qa.example.test",
    createdAt: "2026-10-02T10:00:00.000Z",
    runAt: "2026-10-04T02:15:00.000Z",
  },
  {
    name: "double-submit-creates-duplicate-request",
    branch: "mutant/double-submit-creates-duplicate-request",
    description: "Submitting the request form twice with the same key creates two requests.",
    expectedCatchers: ["idempotent_writes"],
    outcomes: { idempotent_writes: KILLED },
    baseUrl: "https://gracie-m8.qa.example.test",
    createdAt: "2026-10-02T10:10:00.000Z",
    runAt: "2026-10-04T02:30:00.000Z",
  },
  {
    name: UNDEPLOYED_MUTANT_NAME,
    branch: `mutant/${UNDEPLOYED_MUTANT_NAME}`,
    description: "The guest export stops masking the guest email column.",
    expectedCatchers: ["pii_by_role"],
    outcomes: null,
    baseUrl: null,
    createdAt: "2026-10-05T08:00:00.000Z",
    runAt: null,
  },
];

export function seededMutantId(name: string): string {
  return stableId("mutant", name);
}

export function seededMutationRunId(name: string): string {
  return stableId("mutation_run_seed", name);
}

export function seededMutationRunRunId(name: string): string {
  return stableId("run_mutation_seed", name);
}

function outcomesFor(seed: SeededMutant, scenario: MutationScenario): SeededOutcomes | null {
  if (seed.outcomes === null || scenario !== "all_killed") {
    return seed.outcomes;
  }
  return Object.fromEntries(
    Object.keys(seed.outcomes).map((invariantId): [string, MutationOutcome] => [
      invariantId,
      KILLED,
    ]),
  );
}

function seedRun(
  state: MockState,
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
  mutant: Mutant,
  runAt: string,
): void {
  const runId = seededMutationRunRunId(mutant.name);
  const mutationRunId = seededMutationRunId(mutant.name);
  const runAtMs = Date.parse(runAt);
  mutationStore.addRun({
    id: mutationRunId,
    runId,
    mutantId: mutant.id,
    planId: STAGE_TWO_IDS.plans.smartLog,
    outcomes: [],
    power: null,
    startedAt: runAt,
    finishedAt: null,
  });
  launchRun(state, store, {
    kind: "mutation",
    createdBy: MEMBER_USER.id,
    targetId: target.id,
    planId: STAGE_TWO_IDS.plans.smartLog,
    bundleId: record.bundle.id,
    readOnly: false,
    budget: SEEDED_BUDGET,
    configSnapshot: buildConfigSnapshot(record, runAt),
    params: {
      mutation_run_id: mutationRunId,
      mutant_id: mutant.id,
      planned: planOutcomes(store, mutant, "default"),
      fail_reason: null,
    },
    id: runId,
    createdAtMs: runAtMs,
    mode: { kind: "instant", baseMs: runAtMs },
  });
}

function seedGracie(
  state: MockState,
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
  scenario: MutationScenario,
): void {
  for (const seed of SEEDED_MUTANTS) {
    const mutant = mutationStore.addMutant(
      {
        id: seededMutantId(seed.name),
        target_id: target.id,
        name: seed.name,
        branch: seed.branch,
        description: seed.description,
        expected_catchers: [...seed.expectedCatchers],
        base_url: seed.baseUrl,
        status: seed.baseUrl === null ? "registered" : "deployed",
        last_outcome: null,
        created_at: seed.createdAt,
      },
      outcomesFor(seed, scenario) ?? undefined,
    );
    if (seed.runAt !== null) {
      seedRun(state, store, target, record, mutant, seed.runAt);
    }
  }
}

function clearMutationRuns(store: StageTwoStore): void {
  const rows = store.runs;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.run.kind === "mutation") {
      rows.splice(index, 1);
    }
  }
}

export function ensureMutationSeed(
  state: MockState = mockState,
  scenario: MutationScenario = mutationStore.scenarioSource(),
): void {
  if (!mutationStore.resetBound) {
    mutationStore.resetBound = true;
    state.stageTwo.onReset(() => mutationStore.reset());
  }
  if (mutationStore.seededScenario === scenario) {
    return;
  }
  mutationStore.markSeeded(scenario);
  mutationStore.clearData();
  if (state.stageTwo.currentSeed === "empty") {
    return;
  }
  clearMutationRuns(state.stageTwo);
  if (scenario === "none") {
    return;
  }
  const target = state.stageOne.findTarget(STAGE_ONE_IDS.gracie);
  const record = target === undefined ? undefined : state.stageOne.latestValidBundle(target.id);
  if (target !== undefined && record !== undefined) {
    seedGracie(state, state.stageTwo, target, record, scenario);
  }
}
