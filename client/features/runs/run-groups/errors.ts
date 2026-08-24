import { describeApiError, isApiError, type ApiError } from "@/lib/api/errors";

export type RunGroupProblemKind =
  | "production_blocked"
  | "target_not_ready"
  | "forbidden"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "other";

export interface RunGroupProblem {
  kind: RunGroupProblemKind;
  title: string;
  message: string;
  issues: string[];
  rowIndex: number | null;
  rowMessages: Readonly<Record<number, string>>;
}

export const PRODUCTION_BLOCKED_CODE = "production_blocked";
export const TARGET_NOT_READY_CODE = "target_not_ready";

const PLAN_IDS_FIELD = "plan_ids";

function planIndexOf(loc: readonly (string | number)[]): number | null {
  const [scope, field, index] = loc;
  return scope === "body" && field === PLAN_IDS_FIELD && typeof index === "number" ? index : null;
}

function rowMessagesOf(error: ApiError): Record<number, string> {
  const messages: Record<number, string> = {};
  for (const detail of error.details) {
    const index = planIndexOf(detail.loc);
    if (index !== null) {
      messages[index] ??= detail.message;
    }
  }
  return messages;
}

function rowIndexOf(error: ApiError, targetNames: readonly string[]): number | null {
  const fromDetails = error.details.map((detail) => planIndexOf(detail.loc)).find((i) => i !== null);
  if (fromDetails !== undefined) {
    return fromDetails;
  }
  const byName = targetNames.findIndex((name) => name !== "" && error.message.includes(name));
  return byName < 0 ? null : byName;
}

function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages.filter((message) => message.trim() !== ""))];
}

export function classifyRunGroupError(
  error: unknown,
  targetNames: readonly string[],
): RunGroupProblem {
  const fallback: RunGroupProblem = {
    kind: "other",
    title: "Could not start the run group",
    message: describeApiError(error),
    issues: [],
    rowIndex: null,
    rowMessages: {},
  };
  if (!isApiError(error)) {
    return fallback;
  }
  const rowMessages = rowMessagesOf(error);
  const rowIndex = rowIndexOf(error, targetNames);
  if (error.status === 409 && error.code === PRODUCTION_BLOCKED_CODE) {
    return {
      kind: "production_blocked",
      title: "A production target blocks this group",
      message: error.message,
      issues: [
        "Nothing was started. An admin can allow production runs in the target settings; they stay read-only.",
      ],
      rowIndex,
      rowMessages,
    };
  }
  if (error.status === 409 && error.code === TARGET_NOT_READY_CODE) {
    return {
      kind: "target_not_ready",
      title: "A target is not ready",
      message: error.message,
      issues: uniqueMessages(error.details.map((detail) => detail.message)),
      rowIndex,
      rowMessages,
    };
  }
  if (error.status === 409) {
    return { ...fallback, kind: "conflict", rowIndex, rowMessages };
  }
  if (error.status === 403) {
    return {
      ...fallback,
      kind: "forbidden",
      title: "Your role cannot start run groups",
      message: "Starting a run group needs the member role. Ask an admin to change your role.",
    };
  }
  if (error.status === 422) {
    const unmapped = error.details
      .filter((detail) => planIndexOf(detail.loc) === null)
      .map((detail) => detail.message);
    return {
      kind: "invalid",
      title: "The server rejected the selection",
      message: describeApiError(error),
      issues: uniqueMessages(unmapped),
      rowIndex: null,
      rowMessages,
    };
  }
  if (error.status === 503 || error.isNetworkError) {
    return { ...fallback, kind: "unavailable", title: "Could not reach the run service" };
  }
  return fallback;
}
