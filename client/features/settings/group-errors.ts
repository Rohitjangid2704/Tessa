import { describeApiError, isApiError } from "@/lib/api/errors";
import { ADMIN_ONLY_MESSAGE, type SaveFailure } from "./errors";

const REQUEST_BODY_SCOPE = "body";

export function describeGroupFailure(
  error: unknown,
  group: string,
  leaves: readonly string[],
): SaveFailure {
  const fieldMessages: Record<string, string> = {};
  if (!isApiError(error)) {
    return { message: describeApiError(error), fieldMessages };
  }
  if (error.status === 403) {
    return { message: ADMIN_ONLY_MESSAGE, fieldMessages };
  }
  if (error.status !== 422) {
    return { message: describeApiError(error), fieldMessages };
  }
  const unmapped: string[] = [];
  for (const detail of error.details) {
    const [scope, detailGroup, leaf] = detail.loc;
    if (
      scope === REQUEST_BODY_SCOPE &&
      detailGroup === group &&
      typeof leaf === "string" &&
      leaves.includes(leaf)
    ) {
      fieldMessages[leaf] ??= detail.message;
    } else {
      unmapped.push(detail.message);
    }
  }
  const mapped = Object.keys(fieldMessages).length > 0;
  return {
    message:
      mapped && unmapped.length === 0
        ? null
        : unmapped.length > 0
          ? unmapped.join(" ")
          : error.message,
    fieldMessages,
  };
}
