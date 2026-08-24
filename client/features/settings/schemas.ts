import { z } from "zod";
import type { Effort, ModelRole, SecretName, ServiceName, SettingsRead } from "@/lib/api/types";

export const SETTINGS_GROUPS = ["models", "thresholds", "endpoints", "budgets"] as const;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const MODEL_ROLES = [
  "generate",
  "explore",
  "simulate",
  "attack",
  "judge",
  "judge_tiebreak",
  "skeptic",
] as const satisfies readonly ModelRole[];

export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  generate: "Generate",
  explore: "Explore",
  simulate: "Simulate",
  attack: "Attack",
  judge: "Judge",
  judge_tiebreak: "Judge tie-break",
  skeptic: "Skeptic",
};

export const EFFORTS = ["minimal", "low", "medium", "high"] as const satisfies readonly Effort[];

export const MODEL_MAX_LENGTH = 200;
export const SECRET_MAX_LENGTH = 4096;

export interface SecretDefinition {
  name: SecretName;
  label: string;
  description: string;
}

export const SECRET_DEFINITIONS: readonly SecretDefinition[] = [
  {
    name: "openai_api_key",
    label: "OpenAI API key",
    description: "Used by the judge and the generation roles that run on OpenAI models.",
  },
  {
    name: "anthropic_api_key",
    label: "Anthropic API key",
    description: "Used by the tie-break judge and any role set to an Anthropic model.",
  },
  {
    name: "jev_api_key",
    label: "Jev API key",
    description: "Optional second opinion. Off until a Jev URL is set.",
  },
  {
    name: "slack_webhook_url",
    label: "Slack webhook URL",
    description: "Where Slack notifications are posted. Turn Slack on under Notifications.",
  },
  {
    name: "smtp_password",
    label: "SMTP password",
    description:
      "Password for the mail server. Host, port and user come from the worker environment.",
  },
];

export interface ServiceDefinition {
  service: ServiceName;
  label: string;
  description: string;
}

export const SERVICE_DEFINITIONS: readonly ServiceDefinition[] = [
  { service: "laya", label: "Laya", description: "The local grader that answers typed questions." },
  { service: "openai", label: "OpenAI", description: "Free call with the stored OpenAI key." },
  {
    service: "anthropic",
    label: "Anthropic",
    description: "Free call with the stored Anthropic key.",
  },
  { service: "jev", label: "Jev", description: "The Jev URL together with its key." },
  { service: "temporal", label: "Temporal", description: "The workflow engine that runs plans." },
];

export type LeafKind =
  | "model"
  | "effort"
  | "positive-number"
  | "positive-integer"
  | "unit-interval"
  | "url"
  | "optional-url";

export interface LeafSpec {
  id: string;
  group: SettingsGroup;
  path: readonly string[];
  dotted: string;
  kind: LeafKind;
  label: string;
}

export interface SectionFormValues {
  values: Record<string, string>;
  reset: Record<string, boolean>;
}

const MODEL_LEAF_DEFINITIONS = [
  { leaf: "model", kind: "model", label: "model" },
  { leaf: "effort", kind: "effort", label: "effort" },
  { leaf: "max_usd", kind: "positive-number", label: "max USD" },
  { leaf: "timeout_seconds", kind: "positive-integer", label: "timeout in seconds" },
] as const satisfies ReadonlyArray<{ leaf: string; kind: LeafKind; label: string }>;

const FLAT_LEAF_DEFINITIONS: Record<
  Exclude<SettingsGroup, "models">,
  ReadonlyArray<{ leaf: string; kind: LeafKind; label: string }>
> = {
  thresholds: [
    { leaf: "probe_confidence", kind: "unit-interval", label: "Probe confidence" },
    { leaf: "judge_escalate_below", kind: "unit-interval", label: "Escalate to the judge below" },
    { leaf: "label_audit_rate", kind: "unit-interval", label: "Label audit rate" },
  ],
  endpoints: [
    { leaf: "laya_url", kind: "url", label: "Laya URL" },
    { leaf: "jev_url", kind: "optional-url", label: "Jev URL" },
  ],
  budgets: [
    { leaf: "default_max_usd", kind: "positive-number", label: "Default max cost in USD" },
    { leaf: "default_max_minutes", kind: "positive-integer", label: "Default max minutes" },
    { leaf: "max_concurrency", kind: "positive-integer", label: "Max concurrency" },
  ],
};

export function leafId(group: SettingsGroup, ...path: readonly string[]): string {
  return [group, ...path].join("__");
}

function specOf(
  group: SettingsGroup,
  path: readonly string[],
  kind: LeafKind,
  label: string,
): LeafSpec {
  return {
    id: leafId(group, ...path),
    group,
    path,
    dotted: [group, ...path].join("."),
    kind,
    label,
  };
}

const LEAF_SPECS: Record<SettingsGroup, readonly LeafSpec[]> = {
  models: MODEL_ROLES.flatMap((role) =>
    MODEL_LEAF_DEFINITIONS.map((definition) =>
      specOf(
        "models",
        [role, definition.leaf],
        definition.kind,
        `${MODEL_ROLE_LABELS[role]} ${definition.label}`,
      ),
    ),
  ),
  thresholds: FLAT_LEAF_DEFINITIONS.thresholds.map((definition) =>
    specOf("thresholds", [definition.leaf], definition.kind, definition.label),
  ),
  endpoints: FLAT_LEAF_DEFINITIONS.endpoints.map((definition) =>
    specOf("endpoints", [definition.leaf], definition.kind, definition.label),
  ),
  budgets: FLAT_LEAF_DEFINITIONS.budgets.map((definition) =>
    specOf("budgets", [definition.leaf], definition.kind, definition.label),
  ),
};

export function leafSpecs(group: SettingsGroup): readonly LeafSpec[] {
  return LEAF_SPECS[group];
}

export function findLeafSpec(group: SettingsGroup, ...path: readonly string[]): LeafSpec {
  const found = LEAF_SPECS[group].find((spec) => spec.id === leafId(group, ...path));
  if (found === undefined) {
    throw new Error(`Unknown settings leaf ${[group, ...path].join(".")}`);
  }
  return found;
}

export function storedLeaf(settings: SettingsRead, spec: LeafSpec): string | number | null {
  if (spec.group === "models") {
    const [role = "", leaf = ""] = spec.path;
    const model = settings.models[role];
    if (model === undefined) {
      return null;
    }
    return model[leaf as keyof typeof model] ?? null;
  }
  const group: Record<string, string | number | null> = settings[spec.group];
  return group[spec.path[0] ?? ""] ?? null;
}

export function storedText(settings: SettingsRead, spec: LeafSpec): string {
  const stored = storedLeaf(settings, spec);
  return stored === null ? "" : String(stored);
}

export function isOverridden(settings: SettingsRead, spec: LeafSpec): boolean {
  return settings.overrides.includes(spec.dotted);
}

export function defaultSectionValues(
  group: SettingsGroup,
  settings: SettingsRead,
): SectionFormValues {
  const specs = leafSpecs(group);
  return {
    values: Object.fromEntries(specs.map((spec) => [spec.id, storedText(settings, spec)])),
    reset: Object.fromEntries(specs.map((spec) => [spec.id, false])),
  };
}

export function sectionRevision(group: SettingsGroup, settings: SettingsRead): string {
  return leafSpecs(group)
    .map(
      (spec) =>
        `${spec.dotted}=${storedText(settings, spec)}|${isOverridden(settings, spec) ? "db" : "env"}`,
    )
    .join("\n");
}

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const INTEGER_PATTERN = /^\d+$/;
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function parseDecimal(typed: string): number | null {
  const trimmed = typed.trim();
  return DECIMAL_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

export function parseInteger(typed: string): number | null {
  const trimmed = typed.trim();
  return INTEGER_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

export function isHttpUrl(typed: string): boolean {
  try {
    const parsed = new URL(typed.trim());
    return HTTP_PROTOCOLS.has(parsed.protocol) && parsed.host !== "";
  } catch {
    return false;
  }
}

export function validateLeaf(kind: LeafKind, typed: string): string | null {
  const text = typed.trim();
  switch (kind) {
    case "model":
      if (text === "") {
        return "Enter a model name";
      }
      return text.length > MODEL_MAX_LENGTH ? `Use at most ${MODEL_MAX_LENGTH} characters` : null;
    case "effort":
      return EFFORTS.some((effort) => effort === text) ? null : "Choose an effort";
    case "positive-number": {
      const value = parseDecimal(text);
      return value !== null && value > 0 ? null : "Enter a number greater than 0";
    }
    case "positive-integer": {
      const value = parseInteger(text);
      return value !== null && value >= 1 ? null : "Enter a whole number of at least 1";
    }
    case "unit-interval": {
      const value = parseDecimal(text);
      return value !== null && value <= 1 ? null : "Enter a number from 0 to 1";
    }
    case "url":
      return isHttpUrl(text) ? null : "Enter a URL like http://host:port";
    case "optional-url":
      return text === "" || isHttpUrl(text)
        ? null
        : "Enter a URL like https://host, or leave it empty";
  }
}

export function createSectionSchema(group: SettingsGroup) {
  const specs = leafSpecs(group);
  return z
    .object({
      values: z.record(z.string(), z.string()),
      reset: z.record(z.string(), z.boolean()),
    })
    .superRefine((form, context) => {
      for (const spec of specs) {
        if (form.reset[spec.id] === true) {
          continue;
        }
        const message = validateLeaf(spec.kind, form.values[spec.id] ?? "");
        if (message !== null) {
          context.addIssue({ code: "custom", message, path: ["values", spec.id] });
        }
      }
    });
}

export const secretInputSchema = z.object({
  value: z
    .string()
    .min(1, "Enter the key")
    .max(SECRET_MAX_LENGTH, `Use at most ${SECRET_MAX_LENGTH} characters`),
});

export function validateSecretInput(name: SecretName, typed: string): string | null {
  const parsed = secretInputSchema.safeParse({ value: typed });
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? "Enter the key";
  }
  if (name === "slack_webhook_url" && !typed.startsWith("https://")) {
    return "A Slack webhook is an https URL";
  }
  return null;
}
