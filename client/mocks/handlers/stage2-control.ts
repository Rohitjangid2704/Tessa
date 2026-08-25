import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { MAX_SIMULATION_SPEED } from "../simulation/clock";
import { registerHold, releaseHolds } from "../server/run-simulator";
import { readyProductionTarget } from "../stage2/production";
import { isTerminal, stageTwo } from "../stage2/support";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const seedBodySchema = z.strictObject({ seed: z.enum(["gracie", "empty"]) });

const clockBodySchema = z.strictObject({
  speed: z.number().positive().max(MAX_SIMULATION_SPEED).optional(),
  default_speed: z.number().positive().max(MAX_SIMULATION_SPEED).optional(),
  paused: z.boolean().optional(),
  seed: z.number().int().min(0).optional(),
  step_cost_usd: z.number().min(0).optional(),
});

const advanceBodySchema = z.strictObject({
  ms: z.number().min(0).optional(),
  until_idle: z.boolean().optional(),
});

const holdBodySchema = z.strictObject({
  phase: z.string().min(1).max(64),
  run_id: z.guid().optional(),
});

const releaseBodySchema = z.strictObject({
  phase: z.string().min(1).max(64).optional(),
  run_id: z.guid().optional(),
});

const productionBodySchema = z.strictObject({ allow_production: z.boolean().optional() });

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
  const text = await context.request.text();
  const parsed = schema.safeParse(text.trim() === "" ? {} : parseJsonObject(text));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  return parsed.data;
}

function describeState(context: ApiContext) {
  const store = stageTwo(context);
  const { controls } = store;
  return {
    seed: store.currentSeed,
    clock: store.clock.snapshot(),
    controls: {
      seed: controls.seed,
      step_cost_usd: controls.stepCostUsd,
      holds: controls.holds.map((hold) => ({ phase: hold.phase, run_id: hold.runId })),
      held: [...controls.held].map(([runId, phase]) => ({ run_id: runId, phase })),
    },
    runs: store.runs.map(({ run, record }) => ({
      run_id: run.id,
      kind: run.kind,
      status: run.status,
      terminal: isTerminal(run.status),
      events: record.events.length,
    })),
    feeds: { open: store.feedControl.open() },
  };
}

function readState(context: ApiContext): Response {
  return jsonResponse(describeState(context));
}

async function seedStageTwo(context: ApiContext): Promise<Response> {
  const { seed } = await parseBody(context, seedBodySchema);
  const store = stageTwo(context);
  store.reset(seed);
  store.ensure();
  return jsonResponse({
    seed,
    plans: store.plans.length,
    scenarios: store.scenarios.length,
    runs: store.runs.length,
  });
}

async function configureClock(context: ApiContext): Promise<Response> {
  const body = await parseBody(context, clockBodySchema);
  const store = stageTwo(context);
  if (body.default_speed !== undefined) {
    store.clock.defaultSpeed = body.default_speed;
  }
  if (body.speed !== undefined) {
    store.clock.setSpeed(body.speed);
  }
  if (body.paused === true) {
    store.clock.pause();
  } else if (body.paused === false) {
    store.clock.resume();
  }
  if (body.seed !== undefined) {
    store.controls.seed = body.seed;
  }
  if (body.step_cost_usd !== undefined) {
    store.controls.stepCostUsd = body.step_cost_usd;
  }
  return jsonResponse(describeState(context));
}

async function advanceClock(context: ApiContext): Promise<Response> {
  const body = await parseBody(context, advanceBodySchema);
  const store = stageTwo(context);
  if (body.until_idle === true) {
    await store.clock.runUntilIdle();
  } else {
    await store.clock.advance(body.ms ?? 1000);
  }
  return jsonResponse(describeState(context));
}

async function holdPhase(context: ApiContext): Promise<Response> {
  const body = await parseBody(context, holdBodySchema);
  registerHold(stageTwo(context), body.phase, body.run_id?.toLowerCase() ?? null);
  return jsonResponse(describeState(context));
}

async function releasePhase(context: ApiContext): Promise<Response> {
  const body = await parseBody(context, releaseBodySchema);
  const released = releaseHolds(stageTwo(context), {
    phase: body.phase,
    runId: body.run_id?.toLowerCase(),
  });
  return jsonResponse({ released, ...describeState(context) });
}

function dropFeeds(context: ApiContext): Response {
  return jsonResponse({ dropped: stageTwo(context).feedControl.drop() });
}

async function prepareProductionTarget(context: ApiContext): Promise<Response> {
  const body = await parseBody(context, productionBodySchema);
  return jsonResponse(readyProductionTarget(context.state, body.allow_production ?? true));
}

export const stageTwoControlHandlers = [
  http.get("*/__mock/stage2/state", api(readState, CONTROL_OPTIONS)),
  http.post("*/__mock/stage2/seed", api(seedStageTwo, CONTROL_OPTIONS)),
  http.post("*/__mock/stage2/clock", api(configureClock, CONTROL_OPTIONS)),
  http.post("*/__mock/stage2/advance", api(advanceClock, CONTROL_OPTIONS)),
  http.post("*/__mock/stage2/hold", api(holdPhase, CONTROL_OPTIONS)),
  http.post("*/__mock/stage2/release", api(releasePhase, CONTROL_OPTIONS)),
  http.post("*/__mock/stage2/feeds/drop", api(dropFeeds, CONTROL_OPTIONS)),
  http.post("*/__mock/stage2/production-target", api(prepareProductionTarget, CONTROL_OPTIONS)),
];
