import { isProvided, normalizeEnvironmentValue, type EnvironmentFormValues } from "./schemas";
import type { EnvironmentPatch, EnvironmentVariable } from "./types";

export interface EnvironmentFormInput {
  values: Readonly<Record<string, string | undefined>>;
  clear: Readonly<Record<string, boolean | undefined>>;
}

export interface BuiltEnvironmentPatch {
  set: Record<string, string>;
  clear: string[];
}

export function defaultFormValues(
  variables: readonly EnvironmentVariable[],
): EnvironmentFormValues {
  return {
    values: Object.fromEntries(
      variables.map((variable) => [variable.name, variable.secret ? "" : (variable.value ?? "")]),
    ),
    clear: Object.fromEntries(variables.map((variable) => [variable.name, false])),
  };
}

export function buildEnvironmentPatch(
  variables: readonly EnvironmentVariable[],
  form: EnvironmentFormInput,
): BuiltEnvironmentPatch {
  const set: Record<string, string> = {};
  const clear: string[] = [];
  for (const variable of variables) {
    const typed = form.values[variable.name] ?? "";
    if (form.clear[variable.name] === true) {
      if (variable.has_value) {
        clear.push(variable.name);
      }
      continue;
    }
    if (variable.secret) {
      if (isProvided(variable, typed)) {
        set[variable.name] = normalizeEnvironmentValue(variable.kind, typed);
      }
      continue;
    }
    const normalized = isProvided(variable, typed)
      ? normalizeEnvironmentValue(variable.kind, typed)
      : "";
    const stored = normalizeEnvironmentValue(variable.kind, variable.value ?? "");
    if (normalized === stored) {
      continue;
    }
    if (normalized === "") {
      if (variable.has_value) {
        clear.push(variable.name);
      }
      continue;
    }
    set[variable.name] = normalized;
  }
  return { set, clear };
}

export function countPatchChanges(patch: Pick<EnvironmentPatch, "set" | "clear">): number {
  return Object.keys(patch.set ?? {}).length + (patch.clear ?? []).length;
}

export function isPatchEmpty(patch: Pick<EnvironmentPatch, "set" | "clear">): boolean {
  return countPatchChanges(patch) === 0;
}
