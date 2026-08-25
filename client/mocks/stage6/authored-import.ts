import type { BundleUploadResult } from "../factories/bundles";
import { launchRun } from "../server/run-simulator";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { buildConfigSnapshot, DEFAULT_RUN_BUDGET } from "../stage2/plan-service";
import { nowIso } from "../stage2/support";
import type { MockState } from "../state";
import { buildCellScenario, registerScenario } from "./cell-scenarios";
import { publishCoverageUpdated, publishScenarioChanged } from "./coverage-bus";
import { coverageStore, ensureBaselinePlan } from "./coverage-store";

export const AUTHORED_IMPORT_MARKER = "scenarios";

const IMPORT_LIMIT = 3;

type ImportWarning = BundleUploadResult["bundle"]["warnings"][number];

const FILE_WARNINGS: readonly ImportWarning[] = [
  {
    code: "scenario_expect_empty",
    file: "scenarios/guest-escalation.yaml",
    message: "steps[1].expect has no checks, so the step can only fail on Tier 0 problems",
    pointer: "/steps/1/expect",
    line: 14,
    column: 5,
    severity: "warning",
  },
  {
    code: "scenario_unknown_feature",
    file: "scenarios/legacy-export.yaml",
    message: "feature_id reports.flow.export_month is not in the catalog; the scenario was kept",
    pointer: "/feature_id",
    line: 3,
    column: 14,
    severity: "warning",
  },
];

const DRY_RUN_SKIPPED_WARNING: ImportWarning = {
  code: "dry_run_skipped",
  file: "scenarios/",
  message:
    "The target is on tier production, so the imported scenarios were not dry-run and stay in review",
  pointer: null,
  line: null,
  column: null,
  severity: "warning",
};

export function isAuthoredImportName(fileName: string): boolean {
  return fileName.toLowerCase().includes(AUTHORED_IMPORT_MARKER);
}

function startDryRun(
  state: MockState,
  userId: string,
  target: TargetRecord,
  record: BundleRecord,
  planId: string,
  cellIds: readonly string[],
): string {
  const entry = launchRun(state, state.stageTwo, {
    kind: "generate",
    createdBy: userId,
    targetId: target.id,
    planId,
    bundleId: record.bundle.id,
    readOnly: false,
    budget: { ...DEFAULT_RUN_BUDGET },
    configSnapshot: buildConfigSnapshot(record, nowIso()),
    params: { mode: "dry_run", plan_id: planId, cell_ids: [...cellIds], depth: "smoke" },
  });
  return entry.run.id;
}

export function applyAuthoredImport(
  state: MockState,
  accepted: { status: number; body: BundleUploadResult },
  userId: string,
): { status: number; body: BundleUploadResult } {
  const { bundle, created } = accepted.body;
  const { stageOne, stageTwo: store } = state;
  const record = stageOne.findBundle(bundle.id);
  const target = stageOne.findTarget(bundle.target_id);
  if (!created || record === undefined || target === undefined) {
    return accepted;
  }
  if (bundle.validation_status !== "valid") {
    return accepted;
  }
  const dataset = coverageStore.datasetFor(target, record);
  const baseline = ensureBaselinePlan(store, target, record, dataset.cells.length);
  const filled = dataset.cells.filter((cell) => cell.status === "needs_author").slice(0, IMPORT_LIMIT);
  const importedAt = nowIso();
  filled.forEach((cell, ordinal) => {
    const scenario = buildCellScenario({
      dataset,
      cell,
      ordinal: cell.scenarioCount + ordinal,
      origin: "authored",
      status: "in_review",
      variant: null,
      createdAt: importedAt,
      runId: null,
      depth: null,
    });
    registerScenario(state, scenario);
    cell.status = "generated";
    cell.scenarioCount += 1;
    cell.reason = null;
    publishScenarioChanged({
      targetId: target.id,
      scenarioId: scenario.id,
      cellId: cell.id,
      status: scenario.status,
    });
  });
  bundle.scenarios_imported = filled.length;
  bundle.warnings = [...bundle.warnings, ...FILE_WARNINGS];
  let dryRunRunId: string | null = null;
  if (filled.length > 0) {
    if (target.tier === "production") {
      bundle.warnings = [...bundle.warnings, DRY_RUN_SKIPPED_WARNING];
    } else {
      dryRunRunId = startDryRun(
        state,
        userId,
        target,
        record,
        baseline.id,
        filled.map((cell) => cell.id),
      );
    }
    publishCoverageUpdated({
      targetId: target.id,
      planId: baseline.id,
      cellIds: filled.map((cell) => cell.id),
      reason: "generated",
    });
  }
  return { status: accepted.status, body: { ...accepted.body, dry_run_run_id: dryRunRunId } };
}
