import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { SETTINGS_SEEDS } from "../stage4/settings-store";
import { stageFour } from "../stage4/support";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const seedBodySchema = z
  .strictObject({
    seed: z.enum(["default", "empty", "almost_done"]).optional(),
    settings: z.enum(SETTINGS_SEEDS).optional(),
  })
  .refine((body) => body.seed !== undefined || body.settings !== undefined, {
    message: "Send seed, settings or both",
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

async function seedStageFour(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const { seed, settings } = parsed.data;
  const store = stageFour(context);
  if (seed !== undefined) {
    store.reset(seed);
  }
  if (settings !== undefined) {
    store.settings.reset(settings);
  }
  return jsonResponse({
    ...(seed === undefined ? {} : { seed }),
    ...(settings === undefined ? {} : { settings }),
    ...store.labels.counts(),
  });
}

export const stageFourControlHandlers = [
  http.post("*/__mock/stage4/seed", api(seedStageFour, CONTROL_OPTIONS)),
];
