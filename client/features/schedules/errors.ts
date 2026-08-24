import { describeApiError, isApiError } from "@/lib/api/errors";
import type { ScheduleFieldErrors } from "./form-model";

const REQUEST_BODY_SCOPE = "body";

export interface ScheduleFailure {
  message: string | null;
  fieldErrors: ScheduleFieldErrors;
  requestId: string | null;
}

function fieldOf(path: readonly (string | number)[]): string {
  const named: string[] = [];
  for (const segment of path) {
    if (typeof segment === "number") {
      break;
    }
    named.push(segment);
  }
  return named.join(".");
}

export function describeScheduleFailure(error: unknown): ScheduleFailure {
  const fieldErrors: ScheduleFieldErrors = {};
  const requestId = isApiError(error) ? error.requestId : null;
  if (!isApiError(error) || error.status !== 422 || error.details.length === 0) {
    return { message: describeApiError(error), fieldErrors, requestId };
  }
  const unmapped: string[] = [];
  for (const detail of error.details) {
    const [scope, ...path] = detail.loc;
    const field = scope === REQUEST_BODY_SCOPE ? fieldOf(path) : "";
    if (field === "") {
      unmapped.push(detail.message);
    } else {
      fieldErrors[field] ??= detail.message;
    }
  }
  return {
    message: unmapped.length > 0 ? unmapped.join(" ") : null,
    fieldErrors,
    requestId,
  };
}

export function describeActionFailure(action: "update" | "delete", error: unknown): string {
  return `Could not ${action} the schedule. ${describeApiError(error)}`;
}

export function describeRunNowFailure(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403) {
      return "Only members can run a schedule now.";
    }
    if (error.status === 409 && error.code === "production_blocked") {
      return "This plan targets a production system that does not allow runs yet. An admin can enable it on the target.";
    }
  }
  return describeApiError(error);
}
