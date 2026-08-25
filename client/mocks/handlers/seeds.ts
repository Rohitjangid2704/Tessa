import { http } from "msw";
import { MockApiError, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { launchRun } from "../server/run-simulator";
import { BodyReader } from "../stage1/body";
import {
  hashParts,
  pathUuid,
  requireActiveTarget,
  requireIdempotencyKey,
  stageOne,
  withIdempotency,
} from "../stage1/support";
import type { TargetRecord } from "../stage1/store";
import { buildConfigSnapshot, DEFAULT_RUN_BUDGET } from "../stage2/plan-service";
import { isTerminal, stageTwo } from "../stage2/support";
import "../stage3/seeds/register";
import type { SeedAction, SeedRecord } from "../stage3/seeds/types";
import { toSeed } from "../stage3/seeds/views";
import { seedsStore } from "../stage3/support";
import type { RunHandle } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const SEED_PAGE: PageSpec<SeedRecord> = {
  sortKeys: { version: { kind: "number", value: (row) => row.version } },
  defaultSort: "-version",
  getId: (row) => row.id,
};

const CONFLICTING_KINDS = ["suite", "seed"];

function productionBlocked(target: TargetRecord): MockApiError {
  return new MockApiError(
    409,
    "production_blocked",
    `${target.name} is a production target; seeds are never verified or reset there`,
    [
      {
        loc: ["target", "tier"],
        code: "production_blocked",
        message:
          "Seed verify and reset write to or probe the target and are always blocked on production",
      },
    ],
  );
}

function seedNotReady(location: string, code: string, message: string): MockApiError {
  return new MockApiError(409, "target_not_ready", message, [
    { loc: ["seed", location], code, message },
  ]);
}

function confirmationMismatch(): MockApiError {
  const message = "confirm_target_name must equal the exact name of the target";
  return new MockApiError(422, "confirmation_mismatch", message, [
    { loc: ["body", "confirm_target_name"], code: "confirmation_mismatch", message },
  ]);
}

async function listSeeds(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const targetId = pathUuid(context, "target_id");
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, SEED_PAGE);
  query.finish();
  const store = stageOne(context);
  if (store.findTarget(targetId) === undefined) {
    throw notFound("Target not found");
  }
  const page = paginate(seedsStore(context).seedsOf(store, targetId));
  return jsonResponse({ ...page, items: page.items.map((record) => toSeed(store, record)) });
}

async function readSeed(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const seedId = pathUuid(context, "seed_id");
  const store = stageOne(context);
  const record = seedsStore(context).findSeed(store, seedId);
  if (record === undefined) {
    throw notFound("Seed not found");
  }
  return jsonResponse(toSeed(store, record));
}

function resolveSeed(
  context: ApiContext,
  target: TargetRecord,
  seedId: string | null,
): SeedRecord {
  const store = stageOne(context);
  if (seedId !== null) {
    const found = seedsStore(context).findSeed(store, seedId);
    if (found === undefined || found.targetId !== target.id) {
      throw notFound("Seed not found");
    }
    return found;
  }
  const latest = seedsStore(context).latestOf(store, target.id);
  if (latest === undefined) {
    throw seedNotReady(
      "id",
      "seed_missing",
      "The target has no seed material; upload a bundle that declares seeds",
    );
  }
  return latest;
}

function ensureRunnable(record: SeedRecord, action: SeedAction): void {
  if (action === "verify" && !record.hasHashCommand) {
    throw seedNotReady("hash_command", "hook_missing", "The seed has no hash command to run");
  }
  if (action === "reset" && !record.hasResetScript) {
    throw seedNotReady("reset_script_path", "hook_missing", "The seed has no reset script to run");
  }
}

function ensureNoActiveRun(context: ApiContext, target: TargetRecord): void {
  const active = stageTwo(context).runs.find(
    ({ run }) =>
      run.target_id === target.id &&
      CONFLICTING_KINDS.includes(run.kind) &&
      !isTerminal(run.status),
  );
  if (active !== undefined) {
    throw new MockApiError(
      409,
      "conflict",
      "A suite or seed run of this target is still active; wait for it or cancel it before resetting",
      [
        {
          loc: ["target", "runs"],
          code: "active_run",
          message: `Run ${active.run.id} is still active`,
        },
      ],
    );
  }
}

function startSeedRun(
  context: ApiContext,
  userId: string,
  target: TargetRecord,
  record: SeedRecord,
  action: SeedAction,
): RunHandle {
  const bundle = stageOne(context).latestValidBundle(target.id);
  if (bundle === undefined) {
    throw notFound("Bundle of the seed not found");
  }
  const entry = launchRun(context.state, stageTwo(context), {
    kind: "seed",
    createdBy: userId,
    targetId: target.id,
    planId: null,
    bundleId: bundle.bundle.id,
    readOnly: false,
    budget: { max_usd: 0, max_minutes: DEFAULT_RUN_BUDGET.max_minutes },
    configSnapshot: buildConfigSnapshot(bundle, new Date().toISOString()),
    params: { seed_id: record.id, action },
  });
  return {
    run_id: entry.run.id,
    workflow_id: entry.run.workflow_id,
    kind: entry.run.kind,
    status: entry.run.status,
    created_at: entry.run.created_at,
  };
}

async function runSeedAction(context: ApiContext, action: SeedAction): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const reader = new BodyReader(parseJsonObject(raw));
  const seedId = reader.uuid("seed_id", { required: false, nullable: true }) ?? null;
  const confirmName =
    action === "reset" ? reader.string("confirm_target_name", { required: true }) : undefined;
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  const targetId = pathUuid(context, "target_id");
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      const target = requireActiveTarget(context, targetId);
      if (target.tier === "production" || context.state.faults.productionTarget) {
        throw productionBlocked(target);
      }
      if (action === "reset" && confirmName !== target.name) {
        throw confirmationMismatch();
      }
      const record = resolveSeed(context, target, seedId);
      ensureRunnable(record, action);
      if (action === "reset") {
        ensureNoActiveRun(context, target);
      }
      return { status: 202, body: startSeedRun(context, user.id, target, record, action) };
    },
  );
}

export const seedHandlers = [
  http.get("*/api/v1/targets/:target_id/seeds", api(listSeeds)),
  http.get("*/api/v1/seeds/:seed_id", api(readSeed)),
  http.post(
    "*/api/v1/targets/:target_id/seeds/verify",
    api((context) => runSeedAction(context, "verify")),
  ),
  http.post(
    "*/api/v1/targets/:target_id/seeds/reset",
    api((context) => runSeedAction(context, "reset")),
  ),
];
