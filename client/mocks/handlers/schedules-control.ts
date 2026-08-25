import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { SCHEDULE_IDS, SCHEDULES_SEEDS, schedulesStore } from "../stage8/schedules-store";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const seedBodySchema = z.strictObject({ seed: z.enum(SCHEDULES_SEEDS) });

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

function describeSchedules() {
  return {
    seed: schedulesStore.seed,
    count: schedulesStore.all().length,
    schedule_ids: schedulesStore.all().map(({ schedule }) => schedule.id),
    seeded_ids: SCHEDULE_IDS,
  };
}

async function seedSchedules(context: ApiContext): Promise<Response> {
  const parsed = seedBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  schedulesStore.reset(parsed.data.seed);
  return jsonResponse(describeSchedules());
}

function readSchedulesState(): Response {
  return jsonResponse(describeSchedules());
}

export const scheduleControlHandlers = [
  http.get("*/__mock/stage8/schedules", api(readSchedulesState, CONTROL_OPTIONS)),
  http.post("*/__mock/stage8/schedules", api(seedSchedules, CONTROL_OPTIONS)),
];
