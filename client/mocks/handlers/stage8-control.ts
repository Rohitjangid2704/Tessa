import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { HOME_ACTIONS, runHomeAction } from "../stage8/home-script";
import { NOTIFICATION_SEEDS } from "../stage8/notifications-store";
import { HOME_SCENARIOS, stageEight } from "../stage8/store";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 600_000;
const MAX_EMIT_COUNT = 20;

const intervalSchema = z.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS);

const feedSchema = z.strictObject({
  notification_interval_ms: intervalSchema.optional(),
  invalidate_interval_ms: intervalSchema.optional(),
  finding_interval_ms: intervalSchema.optional(),
  paused: z.boolean().optional(),
});

const seedBodySchema = z
  .strictObject({
    seed: z.enum(HOME_SCENARIOS).optional(),
    notifications: z.enum(NOTIFICATION_SEEDS).optional(),
    feed: feedSchema.optional(),
  })
  .refine(
    (body) =>
      body.seed !== undefined || body.notifications !== undefined || body.feed !== undefined,
    { message: "Send seed, notifications, feed or a combination" },
  );

const emitBodySchema = z.strictObject({
  action: z.enum(HOME_ACTIONS),
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

function describeStageEight() {
  const { feed } = stageEight;
  return {
    seed: stageEight.scenario,
    notifications: {
      seed: stageEight.notifications.currentSeed,
      total: stageEight.notifications.all.length,
      unread: stageEight.notifications.unreadCount,
    },
    severity: { ...stageEight.severity },
    feed: {
      notification_interval_ms: feed.notificationIntervalMs,
      invalidate_interval_ms: feed.invalidateIntervalMs,
      finding_interval_ms: feed.findingIntervalMs,
      paused: feed.paused,
      open: stageEight.bus.listenerCount,
    },
  };
}

async function seedStageEight(context: ApiContext): Promise<Response> {
  const { seed, notifications, feed } = await parseBody(context, seedBodySchema);
  if (seed !== undefined) {
    stageEight.setScenario(seed);
  }
  if (notifications !== undefined) {
    stageEight.resetNotifications(notifications);
  }
  if (feed !== undefined) {
    const current = stageEight.feed;
    stageEight.feed = {
      notificationIntervalMs: feed.notification_interval_ms ?? current.notificationIntervalMs,
      invalidateIntervalMs: feed.invalidate_interval_ms ?? current.invalidateIntervalMs,
      findingIntervalMs: feed.finding_interval_ms ?? current.findingIntervalMs,
      paused: feed.paused ?? current.paused,
    };
  }
  return jsonResponse(describeStageEight());
}

async function emitHomeEvents(context: ApiContext): Promise<Response> {
  const { action, count } = await parseBody(context, emitBodySchema);
  for (let index = 0; index < (count ?? 1); index += 1) {
    runHomeAction(context.state, action);
  }
  return jsonResponse({ action, count: count ?? 1, ...describeStageEight() });
}

function readStageEightState(): Response {
  return jsonResponse(describeStageEight());
}

export const stageEightControlHandlers = [
  http.get("*/__mock/stage8/state", api(readStageEightState, CONTROL_OPTIONS)),
  http.post("*/__mock/stage8/seed", api(seedStageEight, CONTROL_OPTIONS)),
  http.post("*/__mock/stage8/emit", api(emitHomeEvents, CONTROL_OPTIONS)),
];
