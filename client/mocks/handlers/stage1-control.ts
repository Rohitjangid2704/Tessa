import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { stageOne } from "../stage1/support";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const seedBodySchema = z.strictObject({ seed: z.enum(["gracie", "empty"]) });

const limitsBodySchema = z.strictObject({
  bundle_max_zip_bytes: z.number().int().min(1).optional(),
  bundle_max_manifest_bytes: z.number().int().min(1).optional(),
  explanation_max_chars: z.number().int().min(1).nullable().optional(),
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

async function seedStageOne(context: ApiContext): Promise<Response> {
  const { seed } = await parseBody(context, seedBodySchema);
  const store = stageOne(context);
  store.reset(seed);
  return jsonResponse({ seed, targets: store.targets.length, bundles: store.bundles.length });
}

async function configureLimits(context: ApiContext): Promise<Response> {
  const overrides = await parseBody(context, limitsBodySchema);
  const store = stageOne(context);
  store.configureLimits(overrides);
  return jsonResponse({ ...store.limits });
}

export const stageOneControlHandlers = [
  http.post("*/__mock/stage1/seed", api(seedStageOne, CONTROL_OPTIONS)),
  http.post("*/__mock/stage1/limits", api(configureLimits, CONTROL_OPTIONS)),
];
