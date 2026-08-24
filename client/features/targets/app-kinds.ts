import type { AppKind, TargetTier } from "./types";

export const APP_KINDS = [
  "web",
  "api",
  "llm_assistant",
  "worker",
  "cli",
] as const satisfies readonly AppKind[];

export const TARGET_TIERS = ["qa", "production"] as const satisfies readonly TargetTier[];

export const APP_KIND_LABELS: Record<AppKind, string> = {
  web: "Web app",
  api: "HTTP API",
  llm_assistant: "LLM assistant",
  worker: "Background worker",
  cli: "Command line tool",
};

export const TARGET_TIER_LABELS: Record<TargetTier, string> = {
  qa: "QA",
  production: "Production",
};

export function appKindLabel(kind: AppKind): string {
  return APP_KIND_LABELS[kind];
}
