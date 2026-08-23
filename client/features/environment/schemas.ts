import { z } from "zod";
import type { EnvVarKind, EnvironmentVariable } from "./types";

export const ENV_VALUE_MAX_LENGTH = 65_536;
export const HEALTH_CHECK_TIMEOUT_MS = 60_000;

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOL_VALUES = new Set(["true", "false"]);

export const ENV_KIND_LABELS: Record<EnvVarKind, string> = {
  url: "URL",
  dsn: "DSN",
  token: "Token",
  password: "Password",
  string: "Text",
  number: "Number",
  bool: "Yes or no",
};

export const KIND_HINTS: Record<EnvVarKind, string> = {
  url: "Like https://host.example.test",
  dsn: "Like postgresql://user:password@host:5432/database",
  token: "Paste the token as it is",
  password: "Type the password",
  string: "Any text",
  number: "A number like 30 or 0.5",
  bool: "On means true, off means false",
};

export function usesSwitch(variable: Pick<EnvironmentVariable, "kind" | "secret">): boolean {
  return variable.kind === "bool" && !variable.secret;
}

function parsedAddress(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.host === "" ? null : parsed;
  } catch {
    return null;
  }
}

export function normalizeEnvironmentValue(kind: EnvVarKind, value: string): string {
  if (kind === "bool") {
    return value.trim().toLowerCase();
  }
  return kind === "url" || kind === "dsn" || kind === "number" ? value.trim() : value;
}

export function validateEnvironmentValue(
  variable: Pick<EnvironmentVariable, "kind" | "secret">,
  value: string,
): string | null {
  if (value.length > ENV_VALUE_MAX_LENGTH) {
    return `Use at most ${ENV_VALUE_MAX_LENGTH} characters`;
  }
  const normalized = normalizeEnvironmentValue(variable.kind, value);
  if (variable.kind === "url" || variable.kind === "dsn") {
    const parsed = parsedAddress(normalized);
    if (parsed === null) {
      return `Enter a ${variable.kind === "url" ? "URL" : "DSN"} like scheme://host`;
    }
    if (variable.kind === "url" && !variable.secret && (parsed.username || parsed.password)) {
      return "A plain URL cannot carry a username or password. Remove them from the URL.";
    }
    return null;
  }
  if (variable.kind === "number") {
    return NUMBER_PATTERN.test(normalized) && Number.isFinite(Number(normalized))
      ? null
      : "Enter a finite number like 30 or 0.5";
  }
  if (variable.kind === "bool") {
    return BOOL_VALUES.has(normalized) ? null : "Choose true or false";
  }
  return null;
}

export const environmentFormShape = z.object({
  values: z.record(z.string(), z.string()),
  clear: z.record(z.string(), z.boolean()),
});

export type EnvironmentFormValues = z.infer<typeof environmentFormShape>;

export function isProvided(variable: Pick<EnvironmentVariable, "secret">, value: string): boolean {
  return variable.secret ? value !== "" : value.trim() !== "";
}

export function createEnvironmentFormSchema(variables: readonly EnvironmentVariable[]) {
  return environmentFormShape.superRefine((form, context) => {
    for (const variable of variables) {
      if (form.clear[variable.name] === true) {
        continue;
      }
      const value = form.values[variable.name] ?? "";
      if (!isProvided(variable, value)) {
        continue;
      }
      const message = validateEnvironmentValue(variable, value);
      if (message !== null) {
        context.addIssue({ code: "custom", path: ["values", variable.name], message });
      }
    }
  });
}
