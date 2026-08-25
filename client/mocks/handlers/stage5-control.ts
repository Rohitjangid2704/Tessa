import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { SCRIPT_ACTIONS } from "../stage5/findings-script";
import { stageFive } from "../stage5/support";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 600_000;
const MAX_EMIT_COUNT = 50;

const intervalSchema = z.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS);

const feedSchema = z.strictObject({
  create_interval_ms: intervalSchema.optional(),
  move_interval_ms: intervalSchema.optional(),
  occurrence_interval_ms: intervalSchema.optional(),
  paused: z.boolean().optional(),
});

const seedBodySchema = z
  .strictObject({
    seed: z.enum(["default", "few", "empty"]).optional(),
    feed: feedSchema.optional(),
  })
  .refine((body) => body.seed !== undefined || body.feed !== undefined, {
    message: "Send seed, feed or both",
  });

const emitBodySchema = z.strictObject({
  action: z.enum(SCRIPT_ACTIONS),
  count: z.number().int().min(1).max(MAX_EMIT_COUNT).optional(),
});

function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        loc: ["body", key],
        code: "extra_forbidden",
        message: "Extra inputs are not permitted",
      }));
    }
    return [
      {
        loc: ["body", ...issue.path.map((segment) => String(segment))],
        code: issue.code,
        message: issue.message,
      },
    ];
  });
}

async function parseBody<Schema extends z.ZodType>(
  context: ApiContext,
  schema: Schema,
): Promise<z.output<Schema>> {
  const parsed = schema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  return parsed.data;
}

function describeFindings(context: ApiContext) {
  const store = stageFive(context).findings;
  const { feed } = store;
  return {
    seed: store.currentSeed,
    total: store.all.length,
    by_status: store.countsByStatus(),
    feed: {
      create_interval_ms: feed.createIntervalMs,
      move_interval_ms: feed.moveIntervalMs,
      occurrence_interval_ms: feed.occurrenceIntervalMs,
      paused: feed.paused,
      open: store.listenerCount,
    },
  };
}

async function seedStageFive(context: ApiContext): Promise<Response> {
  const { seed, feed } = await parseBody(context, seedBodySchema);
  const store = stageFive(context).findings;
  if (seed !== undefined) {
    store.reset(seed);
  }
  if (feed !== undefined) {
    store.feed = {
      createIntervalMs: feed.create_interval_ms ?? store.feed.createIntervalMs,
      moveIntervalMs: feed.move_interval_ms ?? store.feed.moveIntervalMs,
      occurrenceIntervalMs: feed.occurrence_interval_ms ?? store.feed.occurrenceIntervalMs,
      paused: feed.paused ?? store.feed.paused,
    };
  }
  return jsonResponse(describeFindings(context));
}

async function emitFindingEvents(context: ApiContext): Promise<Response> {
  const { action, count } = await parseBody(context, emitBodySchema);
  const store = stageFive(context).findings;
  const emitted: string[] = [];
  for (let index = 0; index < (count ?? 1); index += 1) {
    const changed = store.script.run(action);
    if (changed !== null) {
      emitted.push(changed.id);
    }
  }
  return jsonResponse({ action, finding_ids: emitted, ...describeFindings(context) });
}

function readFindingsState(context: ApiContext): Response {
  return jsonResponse(describeFindings(context));
}

export const stageFiveControlHandlers = [
  http.get("*/__mock/stage5/state", api(readFindingsState, CONTROL_OPTIONS)),
  http.post("*/__mock/stage5/seed", api(seedStageFive, CONTROL_OPTIONS)),
  http.post("*/__mock/stage5/emit", api(emitFindingEvents, CONTROL_OPTIONS)),
];
