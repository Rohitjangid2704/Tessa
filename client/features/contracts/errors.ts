import { readRequestId } from "@/components/states/request-id";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { fieldMessagesFromApiError } from "@/lib/api/form-errors";
import { CONTRACT_FORM_FIELDS } from "./schemas";

export type ContractFormField = (typeof CONTRACT_FORM_FIELDS)[number];

export interface StartCheckProblem {
  title: string;
  message: string;
  issues: string[];
  requestId: string | null;
  fields: Partial<Record<ContractFormField, string>>;
}

function problem(
  error: unknown,
  title: string,
  message: string,
  extra: Partial<Pick<StartCheckProblem, "issues" | "fields">> = {},
): StartCheckProblem {
  return {
    title,
    message,
    issues: extra.issues ?? [],
    requestId: readRequestId(error),
    fields: extra.fields ?? {},
  };
}

export function describeStartCheckError(error: unknown): StartCheckProblem {
  const fallbackTitle = "Could not start the check";
  if (!isApiError(error)) {
    return problem(error, fallbackTitle, describeApiError(error));
  }
  if (error.status === 403) {
    return problem(
      error,
      "Your role cannot start checks",
      "Starting a contract check needs the member role. Ask an admin to change your role.",
    );
  }
  if (error.status === 404) {
    return problem(
      error,
      "A bundle was not found",
      "One of the chosen bundle versions no longer exists. Pick the versions again.",
    );
  }
  if (error.status === 409) {
    return problem(error, fallbackTitle, describeApiError(error));
  }
  if (error.status === 422) {
    const { byField, unmapped } = fieldMessagesFromApiError(error, CONTRACT_FORM_FIELDS);
    const fields: StartCheckProblem["fields"] = {};
    for (const field of CONTRACT_FORM_FIELDS) {
      const message = byField[field];
      if (message !== undefined) {
        fields[field] = message;
      }
    }
    return problem(error, "The server rejected the request", describeApiError(error), {
      issues: [...new Set(unmapped)],
      fields,
    });
  }
  if (error.status === 503 || error.isNetworkError) {
    return problem(error, "Could not reach the contract service", describeApiError(error));
  }
  return problem(error, fallbackTitle, describeApiError(error));
}
