import { describeApiError, isApiError } from "@/lib/api/errors";
import { fieldMessagesFromApiError } from "@/lib/api/form-errors";
import { RETENTION_FIELDS, type RetentionFieldErrors } from "./schemas";

export const RETENTION_ADMIN_ONLY_MESSAGE = "Only admins can change retention.";

export interface RetentionFailure {
  message: string | null;
  fieldMessages: RetentionFieldErrors;
}

export function describeRetentionFailure(error: unknown): RetentionFailure {
  const fieldMessages: RetentionFieldErrors = {};
  if (!isApiError(error)) {
    return { message: describeApiError(error), fieldMessages };
  }
  if (error.status === 403) {
    return { message: RETENTION_ADMIN_ONLY_MESSAGE, fieldMessages };
  }
  if (error.status !== 422) {
    return { message: describeApiError(error), fieldMessages };
  }
  const { byField, unmapped } = fieldMessagesFromApiError(error, RETENTION_FIELDS);
  for (const field of RETENTION_FIELDS) {
    const message = byField[field];
    if (message !== undefined) {
      fieldMessages[field] = message;
    }
  }
  const mapped = Object.keys(fieldMessages).length > 0;
  return {
    message: mapped && unmapped.length === 0 ? null : unmapped.join(" ") || error.message,
    fieldMessages,
  };
}
