import { describeApiError, isApiError } from "@/lib/api/errors";
import { fieldMessagesFromApiError } from "@/lib/api/form-errors";
import { ADMIN_ONLY_USERS_MESSAGE } from "./labels";

export const CREATE_USER_FIELDS = ["email", "name", "role", "password"] as const;

export type CreateUserField = (typeof CREATE_USER_FIELDS)[number];

export interface CreateUserFailure {
  fieldMessages: Partial<Record<CreateUserField, string>>;
  message: string | null;
}

const REQUEST_BODY_SCOPE = "body";

function isCreateUserField(value: unknown): value is CreateUserField {
  return CREATE_USER_FIELDS.some((field) => field === value);
}

export function describeCreateUserFailure(error: unknown): CreateUserFailure {
  const fieldMessages: Partial<Record<CreateUserField, string>> = {};
  if (!isApiError(error)) {
    return { fieldMessages, message: describeApiError(error) };
  }
  if (error.status === 403) {
    return { fieldMessages, message: ADMIN_ONLY_USERS_MESSAGE };
  }
  if (error.status === 409) {
    const [scope, field] = error.details[0]?.loc ?? [];
    if (scope === REQUEST_BODY_SCOPE && isCreateUserField(field)) {
      fieldMessages[field] = error.details[0]?.message ?? error.message;
      return { fieldMessages, message: null };
    }
    return { fieldMessages, message: error.message };
  }
  if (error.status === 422) {
    const { byField, unmapped } = fieldMessagesFromApiError(error, CREATE_USER_FIELDS);
    for (const field of CREATE_USER_FIELDS) {
      const message = byField[field];
      if (message !== undefined) {
        fieldMessages[field] = message;
      }
    }
    const mapped = Object.keys(fieldMessages).length > 0;
    return {
      fieldMessages,
      message: mapped && unmapped.length === 0 ? null : unmapped.join(" ") || error.message,
    };
  }
  return { fieldMessages, message: describeApiError(error) };
}

export function describeUpdateUserFailure(error: unknown): string {
  if (!isApiError(error)) {
    return describeApiError(error);
  }
  if (error.status === 403) {
    return ADMIN_ONLY_USERS_MESSAGE;
  }
  if (error.status === 404) {
    return "This user no longer exists. The list was refreshed.";
  }
  if (error.status === 409 || error.status === 422) {
    return error.details[0]?.message ?? error.message;
  }
  return describeApiError(error);
}
