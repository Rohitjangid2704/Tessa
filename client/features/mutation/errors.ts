import { describeApiError, isApiError } from "@/lib/api/errors";
import { classifyStartError, type StartProblem } from "@/features/runs/start-errors";

const OVERRIDE_FIELD = "base_url_override";

export const OVERRIDE_PRODUCTION_MESSAGE =
  "This URL looks like a production system. A mutation run never runs against production. Use the QA URL of the deployed mutant.";

export interface MutationRunProblem extends StartProblem {
  field: "base_url_override" | null;
}

function mentionsOverride(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.details.some((detail) => detail.loc.some((segment) => segment === OVERRIDE_FIELD))
  );
}

export function describeMutationRunError(error: unknown): MutationRunProblem {
  const base = classifyStartError(error, "blocked");
  if (base.kind === "production_blocked" && mentionsOverride(error)) {
    return {
      ...base,
      title: "The base URL override is not allowed",
      message: OVERRIDE_PRODUCTION_MESSAGE,
      field: OVERRIDE_FIELD,
    };
  }
  if (base.kind === "invalid" && mentionsOverride(error)) {
    return { ...base, field: OVERRIDE_FIELD };
  }
  if (base.kind === "other" || base.kind === "invalid") {
    return { ...base, title: "Could not start the mutation run", field: null };
  }
  if (base.kind === "forbidden") {
    return {
      ...base,
      title: "Your role cannot start mutation runs",
      message: "Starting a mutation run needs the member role. Ask an admin to change your role.",
      field: null,
    };
  }
  return { ...base, field: null };
}

export function describeMutantError(error: unknown): string {
  if (!isApiError(error)) {
    return describeApiError(error);
  }
  if (error.status === 403) {
    return "Your role cannot change mutants. Ask a member or an admin.";
  }
  if (error.status === 404) {
    return "This mutant no longer exists. Reload the list.";
  }
  return describeApiError(error);
}
