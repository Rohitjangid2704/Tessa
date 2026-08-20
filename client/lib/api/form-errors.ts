import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { describeApiError, isApiError } from "./errors";

export type FieldMessages = Partial<Record<string, string>>;

const REQUEST_BODY_SCOPE = "body";

export function fieldMessagesFromApiError(
  error: unknown,
  fields: readonly string[],
): { byField: FieldMessages; unmapped: string[] } {
  const byField: FieldMessages = {};
  const unmapped: string[] = [];
  if (!isApiError(error) || error.status !== 422) {
    return { byField, unmapped };
  }
  for (const detail of error.details) {
    const [scope, field] = detail.loc;
    if (scope === REQUEST_BODY_SCOPE && typeof field === "string" && fields.includes(field)) {
      byField[field] ??= detail.message;
    } else {
      unmapped.push(detail.message);
    }
  }
  return { byField, unmapped };
}

export function applyApiFieldErrors<Values extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<Values>,
  fields: readonly Path<Values>[],
): string | null {
  const { byField, unmapped } = fieldMessagesFromApiError(error, fields);
  const mapped = Object.entries(byField);
  for (const [field, message] of mapped) {
    if (message !== undefined) {
      setError(field as Path<Values>, { type: "server", message });
    }
  }
  if (mapped.length > 0 && unmapped.length === 0) {
    return null;
  }
  return unmapped.length > 0 ? unmapped.join(" ") : describeApiError(error);
}
