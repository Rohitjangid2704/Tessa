import { describeApiError, isApiError } from "@/lib/api/errors";

export interface GenerateProblem {
  kind: "production_blocked" | "not_ready" | "invalid" | "forbidden" | "missing" | "other";
  title: string;
  message: string;
  issues: string[];
}

export const PRODUCTION_BLOCKED_CODE = "production_blocked";
export const TARGET_NOT_READY_CODE = "target_not_ready";

function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages)];
}

export function classifyGenerateError(error: unknown): GenerateProblem {
  if (!isApiError(error)) {
    return {
      kind: "other",
      title: "Could not start the generation",
      message: describeApiError(error),
      issues: [],
    };
  }
  if (error.status === 409 && error.code === PRODUCTION_BLOCKED_CODE) {
    return {
      kind: "production_blocked",
      title: "Generation is blocked on a production target",
      message:
        "production_blocked: scenarios are not generated against production. Copy the Author prompt to write them with Claude Code instead.",
      issues: [],
    };
  }
  if (error.status === 409 && error.code === TARGET_NOT_READY_CODE) {
    return {
      kind: "not_ready",
      title: "The target is not ready",
      message: error.message,
      issues: uniqueMessages(error.details.map((detail) => detail.message)),
    };
  }
  if (error.status === 403) {
    return {
      kind: "forbidden",
      title: "Your role cannot generate scenarios",
      message: "Generating scenarios needs the member role. Ask an admin to change your role.",
      issues: [],
    };
  }
  if (error.status === 404) {
    return {
      kind: "missing",
      title: "The plan no longer exists",
      message: "Reload the coverage page and pick a plan again.",
      issues: [],
    };
  }
  if (error.status === 422) {
    return {
      kind: "invalid",
      title: "The server rejected the request",
      message: describeApiError(error),
      issues: uniqueMessages(error.details.map((detail) => detail.message)),
    };
  }
  return {
    kind: "other",
    title: "Could not start the generation",
    message: describeApiError(error),
    issues: [],
  };
}
