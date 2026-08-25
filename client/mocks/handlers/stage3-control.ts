import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { SEED_STATES } from "../stage3/seeds/types";
import { stageThree } from "../stage3/support";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };
const MAX_SETTLE_MS = 30_000;

const seedBodySchema = z
  .strictObject({
    seed: z.enum(["default", "empty"]).optional(),
    oracle_settle_ms: z.number().int().min(0).max(MAX_SETTLE_MS).nullable().optional(),
    seeds_state: z.enum(SEED_STATES).optional(),
  })
  .refine(
    (body) =>
      body.seed !== undefined ||
      body.oracle_settle_ms !== undefined ||
      body.seeds_state !== undefined,
    { message: "Send seed, oracle_settle_ms, seeds_state or any of them together" },
  );

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

async function seedStageThree(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const { seed, oracle_settle_ms: settleMs, seeds_state: seedsState } = parsed.data;
  const store = stageThree(context);
  if (seed !== undefined) {
    store.reset(seed);
  }
  if (settleMs !== undefined) {
    store.oracle.configure({ settleMs });
  }
  if (seedsState !== undefined) {
    store.seeds.configure(seedsState);
  }
  const totals = store.seeds.totals(context.state.stageOne);
  return jsonResponse({
    ...(seed === undefined ? {} : { seed }),
    oracle: {
      templates: store.oracle.templates.length,
      results: store.oracle.results.length,
      settle_ms: store.oracle.settleOverrideMs,
    },
    seeds: {
      state: store.seeds.state,
      targets: totals.targets,
      versions: totals.versions,
    },
  });
}

export const stageThreeControlHandlers = [
  http.post("*/__mock/stage3/seed", api(seedStageThree, CONTROL_OPTIONS)),
];
