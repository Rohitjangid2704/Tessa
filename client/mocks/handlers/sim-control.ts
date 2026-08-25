import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { ensureSimulationHistory } from "../stage7/sim-history";
import { simulatorsOf } from "../stage7/sim-store";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };
const MIN_TURN_MS = 50;
const MAX_TURN_MS = 10_000;

const seedBodySchema = z
  .strictObject({
    seed: z.enum(["default", "empty"]).optional(),
    sim_outcome: z.enum(["mixed", "pass", "fail"]).optional(),
    sim_turn_ms: z.number().int().min(MIN_TURN_MS).max(MAX_TURN_MS).optional(),
    history: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.seed !== undefined ||
      body.sim_outcome !== undefined ||
      body.sim_turn_ms !== undefined ||
      body.history !== undefined,
    { message: "Send seed, sim_outcome, sim_turn_ms, history or any of them together" },
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

async function seedSimulators(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const { seed, sim_outcome: outcome, sim_turn_ms: turnMs, history } = parsed.data;
  const simulators = simulatorsOf(context.state);
  if (seed !== undefined) {
    simulators.reset(seed);
  }
  if (outcome !== undefined) {
    simulators.configure({ outcome });
  }
  if (turnMs !== undefined) {
    simulators.configure({ turnMs });
  }
  if (history === true) {
    ensureSimulationHistory(context.state);
  }
  return jsonResponse({
    ...(seed === undefined ? {} : { seed }),
    personas: simulators.personas.personas.length,
    goals: simulators.goals.goals.length,
    sessions: simulators.sessions.length,
    sim_outcome: simulators.settings.outcome,
    sim_turn_ms: simulators.settings.turnMs,
  });
}

export const simControlHandlers = [
  http.post("*/__mock/stage7/simulators/seed", api(seedSimulators, CONTROL_OPTIONS)),
];
