import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { stageTwo } from "../stage2/support";
import "../stage7/explore-seed";
import { applyStageSevenSeed } from "../stage7/seeding";
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

async function seedStageSeven(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const store = stageTwo(context);
  store.ensure();
  const applied = applyStageSevenSeed(parsed.data.seed);
  const explorations = store.runs.filter(({ run }) => run.kind === "explore").length;
  return jsonResponse({
    seed: parsed.data.seed,
    seeders: applied,
    explorations,
  });
}

export const stageSevenControlHandlers = [
  http.post("*/__mock/stage7/seed", api(seedStageSeven, CONTROL_OPTIONS)),
];
