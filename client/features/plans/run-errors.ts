import { describeApiError, isApiError, type ApiErrorDetail } from "@/lib/api/errors";

export type RunStartProblem =
  | { kind: "production_blocked"; title: string; message: string }
  | {
      kind: "target_not_ready";
      title: string;
      message: string;
      missingEnvironment: string[];
      missingInterfaces: string[];
      bundleMissing: boolean;
    }
  | { kind: "plan_empty"; title: string; message: string }
  | { kind: "conflict"; title: string; message: string }
  | { kind: "forbidden"; title: string; message: string }
  | { kind: "invalid"; title: string; message: string; issues: string[] }
  | { kind: "unavailable"; title: string; message: string }
  | { kind: "other"; title: string; message: string };

export const PRODUCTION_BLOCKED_CODE = "production_blocked";
export const TARGET_NOT_READY_CODE = "target_not_ready";
export const PLAN_EMPTY_CODE = "plan_empty";
export const IDEMPOTENCY_CONFLICT_CODE = "idempotency_conflict";
export const BUNDLE_MISSING_CODE = "bundle_missing";

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function locNames(details: readonly ApiErrorDetail[], scope: string): string[] {
  return uniqueStrings(
    details.flatMap((detail) => {
      const [first, second] = detail.loc;
      return first === scope && typeof second === "string" ? [second] : [];
    }),
  );
}

function describeNotReady(details: readonly ApiErrorDetail[]) {
  const missingEnvironment = locNames(details, "environment");
  const missingInterfaces = locNames(details, "interface");
  const bundleMissing = details.some(
    (detail) => detail.code === BUNDLE_MISSING_CODE || detail.loc[0] === "bundle",
  );
  return { missingEnvironment, missingInterfaces, bundleMissing };
}

export function classifyRunStartError(error: unknown): RunStartProblem {
  if (!isApiError(error)) {
    return { kind: "other", title: "Could not start the run", message: describeApiError(error) };
  }
  if (error.status === 409 && error.code === PRODUCTION_BLOCKED_CODE) {
    return {
      kind: "production_blocked",
      title: "This target does not allow runs yet",
      message:
        "It is a production target and an admin has not enabled production runs. Once enabled, runs stay read-only and write features are skipped.",
    };
  }
  if (error.status === 409 && error.code === TARGET_NOT_READY_CODE) {
    const { missingEnvironment, missingInterfaces, bundleMissing } = describeNotReady(
      error.details,
    );
    return {
      kind: "target_not_ready",
      title: "The target is not ready to run",
      message: error.message,
      missingEnvironment,
      missingInterfaces,
      bundleMissing,
    };
  }
  if (error.status === 422 && error.code === PLAN_EMPTY_CODE) {
    return {
      kind: "plan_empty",
      title: "Nothing to run",
      message:
        "The selection expands to no runnable cells. Pick other features, roles or an interface mode.",
    };
  }
  if (error.status === 409) {
    return { kind: "conflict", title: "Could not start the run", message: describeApiError(error) };
  }
  if (error.status === 403) {
    return {
      kind: "forbidden",
      title: "Your role cannot start runs",
      message: "Starting a run needs the member role. Ask an admin to change your role.",
    };
  }
  if (error.status === 422) {
    return {
      kind: "invalid",
      title: "The server rejected the plan",
      message: describeApiError(error),
      issues: uniqueStrings(error.details.map((detail) => detail.message)),
    };
  }
  if (error.status === 503 || error.isNetworkError) {
    return {
      kind: "unavailable",
      title: "Could not reach the run service",
      message: describeApiError(error),
    };
  }
  return { kind: "other", title: "Could not start the run", message: describeApiError(error) };
}

export interface PlanFieldErrors {
  k?: string;
  depth?: string;
  max_usd?: string;
  max_minutes?: string;
  name?: string;
  other: string[];
}

const FIELD_BY_LOC: Record<string, keyof Omit<PlanFieldErrors, "other">> = {
  k: "k",
  depth: "depth",
  max_usd: "max_usd",
  max_minutes: "max_minutes",
  name: "name",
};

export function planFieldErrorsFromApiError(error: unknown): PlanFieldErrors {
  const result: PlanFieldErrors = { other: [] };
  if (!isApiError(error) || error.status !== 422) {
    return result;
  }
  for (const detail of error.details) {
    const last = detail.loc.at(-1);
    const field = typeof last === "string" ? FIELD_BY_LOC[last] : undefined;
    if (field === undefined) {
      result.other.push(detail.message);
    } else {
      result[field] ??= detail.message;
    }
  }
  return result;
}

export function hasPlanFieldErrors(errors: PlanFieldErrors): boolean {
  return (
    errors.k !== undefined ||
    errors.depth !== undefined ||
    errors.max_usd !== undefined ||
    errors.max_minutes !== undefined ||
    errors.name !== undefined ||
    errors.other.length > 0
  );
}
