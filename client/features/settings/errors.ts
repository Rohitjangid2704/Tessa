import { describeApiError, isApiError } from "@/lib/api/errors";
import { leafId, leafSpecs, type SettingsGroup } from "./schemas";

const REQUEST_BODY_SCOPE = "body";

export interface SaveFailure {
  message: string | null;
  fieldMessages: Record<string, string>;
}

export const ADMIN_ONLY_MESSAGE = "Only admins can change settings.";

export function describeSaveFailure(error: unknown, group: SettingsGroup): SaveFailure {
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
  const knownIds = new Set(leafSpecs(group).map((spec) => spec.id));
  const unmapped: string[] = [];
  for (const detail of error.details) {
    const [scope, detailGroup, ...path] = detail.loc;
    const id =
      scope === REQUEST_BODY_SCOPE && detailGroup === group
        ? leafId(group, ...path.map(String))
        : null;
    if (id !== null && knownIds.has(id)) {
      fieldMessages[id] ??= detail.message;
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

export function describeSecretFailure(error: unknown): string {
  if (!isApiError(error)) {
    return describeApiError(error);
  }
  if (error.status === 403) {
    return ADMIN_ONLY_MESSAGE;
  }
  if (error.status === 422) {
    return error.details[0]?.message ?? error.message;
  }
  return describeApiError(error);
}

export function describeTestRequestFailure(error: unknown): string {
  if (isApiError(error) && error.status === 403) {
    return ADMIN_ONLY_MESSAGE;
  }
  return describeApiError(error);
}
