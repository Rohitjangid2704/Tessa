import { http } from "msw";
import type { RetentionPolicy } from "@/lib/api/types";
import { validationFailed } from "../factories/errors";
import { FieldValidator, parseJsonObject } from "../factories/validation";
import {
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  retentionStore,
} from "../stage10/retention-store";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const POLICY_FIELDS = ["steps_days", "artifacts_days", "run_events_days"] as const;

async function readRetention(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  return jsonResponse(retentionStore.read());
}

async function writeRetention(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const body = parseJsonObject(await context.request.text());
  const validator = new FieldValidator("body");
  const values: Partial<Record<(typeof POLICY_FIELDS)[number], number>> = {};
  for (const field of POLICY_FIELDS) {
    if (body[field] === undefined) {
      validator.details.push({ loc: ["body", field], code: "missing", message: "Field required" });
      continue;
    }
    const value = validator.integer(body, field, {
      min: RETENTION_MIN_DAYS,
      max: RETENTION_MAX_DAYS,
    });
    if (value !== undefined) {
      values[field] = value;
    }
  }
  if (validator.details.length > 0) {
    throw validationFailed(validator.details);
  }
  const policy: RetentionPolicy = {
    steps_days: values.steps_days ?? RETENTION_MIN_DAYS,
    artifacts_days: values.artifacts_days ?? RETENTION_MIN_DAYS,
    run_events_days: values.run_events_days ?? RETENTION_MIN_DAYS,
  };
  return jsonResponse(retentionStore.write(policy));
}

export const retentionHandlers = [
  http.get("*/api/v1/settings/retention", api(readRetention)),
  http.put("*/api/v1/settings/retention", api(writeRetention)),
];
