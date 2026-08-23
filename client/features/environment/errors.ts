import { describeApiError, isApiError } from "@/lib/api/errors";
import { HEALTH_CHECK_TIMEOUT_MS } from "./schemas";

const REQUEST_BODY_SCOPE = "body";
const SET_SCOPE = "set";

export interface SaveFailure {
  message: string | null;
  fieldMessages: Record<string, string>;
}

export interface HealthFailure {
  title: string;
  message: string;
  notReady: boolean;
}

export function describeSaveFailure(error: unknown): SaveFailure {
  const fieldMessages: Record<string, string> = {};
  if (!isApiError(error)) {
    return { message: describeApiError(error), fieldMessages };
  }
  if (error.status === 422) {
    const unmapped: string[] = [];
    for (const detail of error.details) {
      const [scope, section, name] = detail.loc;
      if (scope === REQUEST_BODY_SCOPE && section === SET_SCOPE && typeof name === "string") {
        fieldMessages[name] ??= detail.message;
      } else {
        unmapped.push(detail.message);
      }
    }
    return {
      message:
        Object.keys(fieldMessages).length > 0 && unmapped.length === 0
          ? null
          : unmapped.length > 0
            ? unmapped.join(" ")
            : error.message,
      fieldMessages,
    };
  }
  if (error.status === 409) {
    return {
      message: "This target is archived, so its environment can no longer change.",
      fieldMessages,
    };
  }
  if (error.status === 403) {
    return {
      message: "Your role cannot change environment values. Ask a member or an admin.",
      fieldMessages,
    };
  }
  return { message: describeApiError(error), fieldMessages };
}

function isTimeout(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.isNetworkError &&
    error.cause instanceof DOMException &&
    error.cause.name === "TimeoutError"
  );
}

export function describeHealthFailure(error: unknown): HealthFailure {
  if (isTimeout(error)) {
    return {
      title: "Health checks timed out",
      message: `The checks ran longer than ${HEALTH_CHECK_TIMEOUT_MS / 1000} s and were stopped. The last stored result is still shown. Try again, or check one interface at a time.`,
      notReady: false,
    };
  }
  if (isApiError(error) && error.status === 409 && error.code === "target_not_ready") {
    return {
      title: "No valid bundle yet",
      message: "Health checks need the interfaces of a valid bundle. Upload one first.",
      notReady: true,
    };
  }
  if (isApiError(error) && error.status === 409) {
    return {
      title: "Health checks are not available",
      message: "This target is archived, so health checks cannot run.",
      notReady: false,
    };
  }
  if (isApiError(error) && error.status === 403) {
    return {
      title: "Health checks are not allowed",
      message: "Your role cannot run health checks. Ask a member or an admin.",
      notReady: false,
    };
  }
  return {
    title: "Health checks failed to run",
    message: describeApiError(error),
    notReady: false,
  };
}
