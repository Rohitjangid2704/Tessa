import { describeApiError, isApiError, type ApiErrorDetail } from "@/lib/api/errors";

export type PullProblemKind = "upstream" | "no_source" | "forbidden" | "unavailable" | "other";

export interface PullProblem {
  kind: PullProblemKind;
  title: string;
  message: string;
  details: readonly ApiErrorDetail[];
  requestId: string | null;
}

export const UPSTREAM_ERROR_CODE = "upstream_error";

export function describePullError(error: unknown): PullProblem {
  const details = isApiError(error) ? error.details : [];
  const requestId = isApiError(error) ? error.requestId : null;
  if (isApiError(error) && error.status === 502 && error.code === UPSTREAM_ERROR_CODE) {
    return {
      kind: "upstream",
      title: "Git could not deliver the repository",
      message: error.message,
      details,
      requestId,
    };
  }
  if (isApiError(error) && error.status === 404) {
    return {
      kind: "no_source",
      title: "No git source is saved for this target",
      message: "Save the repository, branch and credential first, then pull again.",
      details,
      requestId,
    };
  }
  if (isApiError(error) && error.status === 403) {
    return {
      kind: "forbidden",
      title: "Your role cannot pull from git",
      message: "Pulling needs the member role. Ask an admin to change your role.",
      details,
      requestId,
    };
  }
  if (isApiError(error) && (error.status === 503 || error.isNetworkError)) {
    return {
      kind: "unavailable",
      title: "Could not reach the import service",
      message: describeApiError(error),
      details,
      requestId,
    };
  }
  return {
    kind: "other",
    title: "Could not pull from git",
    message: describeApiError(error),
    details,
    requestId,
  };
}
