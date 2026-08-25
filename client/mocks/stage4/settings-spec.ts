import type {
  BudgetSettings,
  Effort,
  EndpointSettings,
  ModelRole,
  NotificationSettings,
  PolicySettings,
  SecretName,
  ServiceName,
  ThresholdSettings,
} from "@/lib/api/types";

export const MODEL_ROLES = [
  "generate",
  "explore",
  "simulate",
  "attack",
  "judge",
  "judge_tiebreak",
  "skeptic",
] as const satisfies readonly ModelRole[];

export const EFFORTS = ["minimal", "low", "medium", "high"] as const satisfies readonly Effort[];

export const SECRET_NAMES = [
  "openai_api_key",
  "anthropic_api_key",
  "jev_api_key",
  "slack_webhook_url",
  "smtp_password",
] as const satisfies readonly SecretName[];

export const TESTABLE_SERVICES = [
  "laya",
  "openai",
  "anthropic",
  "jev",
  "temporal",
  "slack",
  "smtp",
] as const satisfies readonly ServiceName[];

export const ALL_SERVICES = TESTABLE_SERVICES;

export const MODEL_LEAVES = ["model", "effort", "max_usd", "timeout_seconds"] as const;

export type ModelLeaf = (typeof MODEL_LEAVES)[number];

export interface ModelDefaults {
  model: string;
  effort: Effort;
  max_usd: number;
  timeout_seconds: number;
}

export interface SettingsDefaults {
  models: Record<ModelRole, ModelDefaults>;
  thresholds: ThresholdSettings;
  endpoints: EndpointSettings;
  budgets: BudgetSettings;
  notifications: NotificationSettings;
  policies: PolicySettings;
}

export function createSettingsDefaults(): SettingsDefaults {
  return {
    models: {
      generate: { model: "gpt-5.2", effort: "medium", max_usd: 0.5, timeout_seconds: 120 },
      explore: { model: "gpt-5.2", effort: "medium", max_usd: 1, timeout_seconds: 180 },
      simulate: { model: "gpt-5-mini", effort: "low", max_usd: 0.25, timeout_seconds: 120 },
      attack: { model: "gpt-5.2", effort: "high", max_usd: 1, timeout_seconds: 180 },
      judge: { model: "gpt-5-mini", effort: "low", max_usd: 0.05, timeout_seconds: 60 },
      judge_tiebreak: {
        model: "claude-sonnet-5-5",
        effort: "low",
        max_usd: 0.05,
        timeout_seconds: 60,
      },
      skeptic: { model: "gpt-5.2", effort: "medium", max_usd: 0.1, timeout_seconds: 90 },
    },
    thresholds: { probe_confidence: 0.75, judge_escalate_below: 0.6, label_audit_rate: 0.05 },
    endpoints: { laya_url: "http://127.0.0.1:7006", jev_url: null },
    budgets: { default_max_usd: 5, default_max_minutes: 30, max_concurrency: 4 },
    notifications: { slack_enabled: false, email_to: [] },
    policies: { flaky_quarantine_after: 3 },
  };
}

export const SETTINGS_GROUPS = [
  "models",
  "thresholds",
  "endpoints",
  "budgets",
  "notifications",
  "policies",
] as const;

export type SettingsGroupName = (typeof SETTINGS_GROUPS)[number];

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_MAX_ITEMS = 20;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const MODEL_MAX_LENGTH = 200;
export const URL_MAX_LENGTH = 2048;
