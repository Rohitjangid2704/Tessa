import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import "../stage10/seed-modules";
import { applyStageTenSeed, stageTenSeederNames } from "../stage10/seeding";
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

async function seedStageTen(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const seeders = stageTenSeederNames();
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
  const results = applyStageTenSeed(seed, context.state, variants);
  return jsonResponse({ seed, variants, seeders, results });
}

export const stageTenControlHandlers = [
  http.post("*/__mock/stage10/seed", api(seedStageTen, CONTROL_OPTIONS)),
];
