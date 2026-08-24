import { describeApiError, isApiError } from "@/lib/api/errors";

export const UNKNOWN_HINT_CODE = "unknown_hint";

export function isUnknownHintError(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 422 &&
    error.details.some((detail) => detail.code === UNKNOWN_HINT_CODE)
  );
}

export function describePromptIssueError(error: unknown): string {
  if (!isApiError(error)) {
    return describeApiError(error);
  }
  if (isUnknownHintError(error)) {
    return "One of the selected hints does not exist for this app kind. Reload the hints and try again.";
  }
  if (error.status === 409) {
    return "This target is archived, so it cannot issue new prompts.";
  }
  if (error.status === 403) {
    return "Your role cannot issue prompts. Ask a member or an admin.";
  }
  if (error.status === 404) {
    return "This target no longer exists.";
  }
  return describeApiError(error);
}
