import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import "../stage9/seed-modules";
import { applyStageNineSeed, stageNineSeederNames } from "../stage9/seeding";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const seedBodySchema = z.strictObject({
  seed: z.enum(["default", "empty"]),
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

async function seedStageNine(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  context.state.stageTwo.ensure();
  const results = applyStageNineSeed(parsed.data.seed, context.state);
  return jsonResponse({
    seed: parsed.data.seed,
    seeders: stageNineSeederNames(),
    results,
  });
}

export const stageNineControlHandlers = [
  http.post("*/__mock/stage9/seed", api(seedStageNine, CONTROL_OPTIONS)),
];
