import { describeApiError, isApiError } from "@/lib/api/errors";

export type StartProductionPolicy = "read_only" | "blocked";

export type StartProblemKind =
  | "production_blocked"
  | "target_not_ready"
  | "forbidden"
  | "too_large"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "other";

export interface StartProblem {
  kind: StartProblemKind;
  title: string;
  message: string;
  issues: string[];
}

export const PRODUCTION_BLOCKED_CODE = "production_blocked";
export const TARGET_NOT_READY_CODE = "target_not_ready";

export const PRODUCTION_READ_ONLY_REFUSED_MESSAGE =
  "This is a production target and an admin has not enabled production runs for it. Once enabled, the session stays read-only.";

export const PRODUCTION_ALWAYS_BLOCKED_MESSAGE =
  "This kind of session is never run against a production target. Pick a QA target.";

function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages.filter((message) => message.trim() !== ""))];
}

export function classifyStartError(
  error: unknown,
  policy: StartProductionPolicy = "read_only",
): StartProblem {
  const fallback: StartProblem = {
    kind: "other",
    title: "Could not start the session",
    message: describeApiError(error),
    issues: [],
  };
  if (!isApiError(error)) {
    return fallback;
  }
  if (error.status === 409 && error.code === PRODUCTION_BLOCKED_CODE) {
    return {
      kind: "production_blocked",
      title: "This target does not allow the session",
      message:
        policy === "blocked" ? PRODUCTION_ALWAYS_BLOCKED_MESSAGE : PRODUCTION_READ_ONLY_REFUSED_MESSAGE,
      issues: [],
    };
  }
  if (error.status === 409 && error.code === TARGET_NOT_READY_CODE) {
    return {
      kind: "target_not_ready",
      title: "The target is not ready",
      message: error.message,
      issues: uniqueMessages(error.details.map((detail) => detail.message)),
    };
  }
  if (error.status === 409) {
    return { ...fallback, kind: "conflict" };
  }
  if (error.status === 403) {
    return {
      kind: "forbidden",
      title: "Your role cannot start sessions",
      message: "Starting a session needs the member role. Ask an admin to change your role.",
      issues: [],
    };
  }
  if (error.status === 413) {
    return { ...fallback, kind: "too_large", title: "The upload is too large" };
  }
  if (error.status === 422) {
    return {
      kind: "invalid",
      title: "The server rejected the request",
      message: describeApiError(error),
      issues: uniqueMessages(error.details.map((detail) => detail.message)),
    };
  }
  if (error.status === 503 || error.isNetworkError) {
    return { ...fallback, kind: "unavailable", title: "Could not reach the run service" };
  }
  return fallback;
}
