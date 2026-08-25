import { conflict, dependencyUnavailable } from "../factories/errors";
import type { ApiContext } from "../handlers/api";
import { launchRun } from "../server/run-simulator";
import { buildConfigSnapshot } from "../stage2/plan-service";
import { isTerminal, nowIso } from "../stage2/support";
import { requireActiveTarget } from "../stage1/support";
import type { MockUser } from "../types";
import "../streams/calibration-script";
import type { RunConfigSnapshot, RunHandle } from "@/lib/api/types";
import { calibrationFits } from "./calibration-fit-store";
import { heldOutLabelsFor } from "./calibration-fit-data";
import { buildLabelStats } from "./labels-volume";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_HASH_LENGTH = 64;
const FIT_BUDGET = { max_usd: 1, max_minutes: 10 };

function placeholderSnapshot(createdAt: string): RunConfigSnapshot {
  return {
    bundle_id: NIL_UUID,
    bundle_version: 0,
    bundle_hash: "0".repeat(PLACEHOLDER_HASH_LENGTH),
    seed_hash: null,
    clock: { mode: "real", at: createdAt },
    models: {},
    probe_bank_version: null,
    prompt_template_versions: {},
    scenario_versions: {},
  };
}

function hasActiveFit(context: ApiContext, targetId: string | null): boolean {
  return context.state.stageTwo.runs.some(
    ({ run }) => run.kind === "calibration" && run.target_id === targetId && !isTerminal(run.status),
  );
}

export function startCalibrationFit(
  context: ApiContext,
  user: MockUser,
  targetId: string | null,
): RunHandle {
  const { state } = context;
  if (state.faults.isDependencyDown("temporal")) {
    throw dependencyUnavailable("temporal", "Temporal is not running");
  }
  if (state.faults.isDependencyDown("laya")) {
    throw dependencyUnavailable("laya", "Laya is not running");
  }
  const target = targetId === null ? null : requireActiveTarget(context, targetId);
  if (hasActiveFit(context, target?.id ?? null)) {
    throw conflict("conflict", "A calibration fit is already running for this scope");
  }
  const createdAt = nowIso();
  const latest = target === null ? undefined : state.stageOne.latestBundle(target.id);
  const behaviour = calibrationFits.consumeBehaviour();
  const entry = launchRun(state, state.stageTwo, {
    kind: "calibration",
    createdBy: user.id,
    targetId: target?.id ?? null,
    planId: null,
    bundleId: null,
    readOnly: true,
    budget: { ...FIT_BUDGET },
    configSnapshot:
      latest === undefined ? placeholderSnapshot(createdAt) : buildConfigSnapshot(latest, createdAt),
  });
  calibrationFits.add({
    runId: entry.run.id,
    targetId: entry.run.target_id,
    createdAt,
    behaviour,
    heldOutLabels: heldOutLabelsFor(buildLabelStats(state.stageFour.labels).total_human),
  });
  return {
    run_id: entry.run.id,
    workflow_id: entry.run.workflow_id,
    kind: entry.run.kind,
    status: entry.run.status,
    created_at: entry.run.created_at,
  };
}
