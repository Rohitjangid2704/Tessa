import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import {
  agentSessionControlSchema,
  fireAgentSessionChange,
} from "../stage11/agent-sessions-control";
import "../stage11/seed-modules";
import { applyStageElevenSeed, stageElevenSeederNames } from "../stage11/seeding";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const seedBodySchema = z
  .strictObject({
    seed: z.enum(["default", "empty"]).optional(),
    variants: z.record(z.string(), z.string()).optional(),
  })
  .refine((body) => body.seed !== undefined || body.variants !== undefined, {
    message: "Send seed, variants or both",
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

async function seedStageEleven(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const seeders = stageElevenSeederNames();
  const variants = parsed.data.variants ?? {};
  const unknown = Object.keys(variants).filter((name) => !seeders.includes(name));
  if (unknown.length > 0) {
    throw validationFailed(
      unknown.map((name) => ({
        loc: ["body", "variants", name],
        code: "unknown_seeder",
        message: `Unknown seeder '${name}'; known: ${seeders.join(", ")}`,
      })),
    );
  }
  const seed = parsed.data.seed ?? "default";
  context.state.stageTwo.ensure();
  const results = applyStageElevenSeed(seed, context.state, variants);
  return jsonResponse({ seed, variants, seeders, results });
}

async function fireAgentSession(context: ApiContext): Promise<Response> {
  const parsed = agentSessionControlSchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  context.state.stageTwo.ensure();
  return jsonResponse(fireAgentSessionChange(parsed.data));
}

export const stageElevenControlHandlers = [
  http.post("*/__mock/stage11/seed", api(seedStageEleven, CONTROL_OPTIONS)),
  http.post("*/__mock/stage11/agent-session", api(fireAgentSession, CONTROL_OPTIONS)),
];
