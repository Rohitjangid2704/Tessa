import { describeApiError, isApiError } from "@/lib/api/errors";
import { FORM_ERROR_KEY, type FieldErrors } from "./validate";

export type ErrorScope = readonly (string | number)[];

export interface ServerFieldErrors {
  byField: FieldErrors;
  general: string[];
}

export const PARAMS_ERROR_SCOPE: ErrorScope = ["body", "params"];

function startsWith(loc: readonly (string | number)[], scope: ErrorScope): boolean {
  return scope.every((segment, index) => String(loc[index]) === String(segment));
}

export function serverFieldErrors(error: unknown, scope: ErrorScope): ServerFieldErrors {
  const byField: FieldErrors = {};
  const general: string[] = [];
  if (!isApiError(error)) {
    return { byField, general: [describeApiError(error)] };
  }
  if (error.status !== 422 || error.details.length === 0) {
    return { byField, general: [describeApiError(error)] };
  }
  for (const detail of error.details) {
    if (!startsWith(detail.loc, scope)) {
      general.push(detail.message);
      continue;
    }
    const field = detail.loc.slice(scope.length).join(".");
    if (field === FORM_ERROR_KEY) {
      general.push(detail.message);
    } else {
      byField[field] ??= detail.message;
    }
  }
  return { byField, general };
}
