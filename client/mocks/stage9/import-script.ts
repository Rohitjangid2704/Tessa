import { registerRunScript } from "../server/run-simulator";
import type {
  RunScript,
  RunScriptFactory,
  ScriptAction,
  ScriptContext,
} from "../simulation/script";
import { ingestBundle } from "../stage1/ingest";
import { STAGE_ONE_ORIGIN } from "../stage1/seed";
import { stableHex } from "../stage2/ids";
import { nowIso } from "../stage2/support";
import { bundleSources } from "./bundle-source-store";
import { appendBundleVariant } from "./bundle-variants";

const PLANNING_AT_MS = 300;
const FETCH_DONE_AT_MS = 1700;
const FINISHING_AT_MS = 2900;
const FINISH_AT_MS = 3000;
const COMMIT_HASH_LENGTH = 40;

interface ImportParams {
  targetId: string;
  userId: string;
  ref: string;
  gitUrl: string;
  fail: boolean;
}

function readText(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function readImportParams(params: Record<string, unknown>): ImportParams {
  return {
    targetId: readText(params, "target_id"),
    userId: readText(params, "user_id"),
    ref: readText(params, "ref"),
    gitUrl: readText(params, "git_url"),
    fail: params.fail === true,
  };
}

function importFailureReason(params: ImportParams): string {
  return `upstream_error: git clone of ${params.gitUrl} failed: Remote branch ${params.ref} not found in upstream origin`;
}

function createImportedBundle(context: ScriptContext, params: ImportParams): void {
  const { state, run } = context;
  const store = state.stageOne;
  const target = store.findTarget(params.targetId);
  if (target === undefined) {
    return;
  }
  const now = nowIso();
  const note = `Pulled from git (${params.ref})`;
  const base = store.latestValidBundle(target.id) ?? store.latestBundle(target.id);
  const record =
    base === undefined
      ? ingestBundle({
          store,
          target,
          kind: "valid",
          source: "git",
          note,
          uploadedBy: params.userId,
          origin: STAGE_ONE_ORIGIN,
          now,
        }).record
      : appendBundleVariant(store, target, {
          base,
          source: "git",
          note,
          uploadedAt: now,
          revisionLabel: `pulled from ${params.ref}`,
          uploadedBy: params.userId,
        });
  run.bundle_id = record.bundle.id;
  bundleSources.recordPull(
    target.id,
    now,
    stableHex(COMMIT_HASH_LENGTH, "git_ref", params.ref, record.bundle.id),
  );
}

export const importRunFactory: RunScriptFactory = ({ params }): RunScript => {
  const input = readImportParams(params);
  const actions: ScriptAction[] = [
    { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
    {
      atMs: PLANNING_AT_MS,
      label: "fetching",
      checkpoint: "planning",
      run: (context) => context.setStatus("planning", `Cloning ${input.gitUrl} at ${input.ref}`),
    },
  ];
  if (input.fail) {
    actions.push({
      atMs: FETCH_DONE_AT_MS,
      label: "fetch failed",
      run: (context) => context.finish("failed", importFailureReason(input)),
    });
    return { actions };
  }
  actions.push(
    {
      atMs: FETCH_DONE_AT_MS,
      label: "validating",
      checkpoint: "running",
      run: (context) => context.setStatus("running", "Validating the bundle"),
    },
    { atMs: FINISHING_AT_MS, label: "finishing", checkpoint: "finishing", run: () => undefined },
    {
      atMs: FINISH_AT_MS,
      label: "finish",
      run: (context) => {
        createImportedBundle(context, input);
        context.finish("completed");
      },
    },
  );
  return { actions };
};

registerRunScript("import", importRunFactory);
