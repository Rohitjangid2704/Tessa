import type { ModelRole, SecretName, SecretStatus, SettingsRead } from "@/lib/api/types";
import { ADMIN_USER } from "../factories/users";
import type { LeafValue, ParsedLeaf } from "./settings-patch";
import {
  createSettingsDefaults,
  MODEL_ROLES,
  SECRET_NAMES,
  type ModelDefaults,
  type SettingsDefaults,
} from "./settings-spec";

export type SettingsSeed = "default" | "overridden" | "unconfigured";

export const SETTINGS_SEEDS = [
  "default",
  "overridden",
  "unconfigured",
] as const satisfies readonly SettingsSeed[];

const SEEDED_SECRET_SET_AT = "2026-09-28T09:15:00.000Z";

interface StoredSecret {
  at: string;
  by: string;
}

interface SecretRecord {
  envProvided: boolean;
  stored: StoredSecret | null;
}

const OVERRIDDEN_SEED: ReadonlyArray<readonly [string, LeafValue]> = [
  ["models.judge.effort", "high"],
  ["models.judge.max_usd", 0.1],
  ["thresholds.probe_confidence", 0.8],
  ["endpoints.jev_url", "https://jev.qa.example.test"],
  ["budgets.default_max_usd", 10],
];

function seededSecrets(seed: SettingsSeed): Map<SecretName, SecretRecord> {
  const stored = { at: SEEDED_SECRET_SET_AT, by: ADMIN_USER.id };
  const records = new Map<SecretName, SecretRecord>(
    SECRET_NAMES.map((name) => [name, { envProvided: false, stored: null }]),
  );
  if (seed === "unconfigured") {
    return records;
  }
  records.set("openai_api_key", { envProvided: true, stored: null });
  records.set("anthropic_api_key", { envProvided: false, stored });
  records.set("smtp_password", { envProvided: false, stored });
  return records;
}

export class SettingsStore {
  private defaults: SettingsDefaults = createSettingsDefaults();
  private overrides = new Map<string, LeafValue>();
  private secrets = new Map<SecretName, SecretRecord>();

  constructor() {
    this.reset();
  }

  reset(seed: SettingsSeed = "default"): void {
    this.defaults = createSettingsDefaults();
    this.overrides = new Map(seed === "overridden" ? OVERRIDDEN_SEED : []);
    this.secrets = seededSecrets(seed);
  }

  read(): SettingsRead {
    const { thresholds, endpoints, budgets, notifications, policies } = this.defaults;
    return {
      models: Object.fromEntries(MODEL_ROLES.map((role) => [role, this.readModel(role)])),
      thresholds: {
        probe_confidence: this.numberLeaf(
          "thresholds.probe_confidence",
          thresholds.probe_confidence,
        ),
        judge_escalate_below: this.numberLeaf(
          "thresholds.judge_escalate_below",
          thresholds.judge_escalate_below,
        ),
        label_audit_rate: this.numberLeaf(
          "thresholds.label_audit_rate",
          thresholds.label_audit_rate,
        ),
      },
      endpoints: {
        laya_url: this.stringLeaf("endpoints.laya_url", endpoints.laya_url),
        jev_url: this.nullableStringLeaf("endpoints.jev_url", endpoints.jev_url),
      },
      budgets: {
        default_max_usd: this.numberLeaf("budgets.default_max_usd", budgets.default_max_usd),
        default_max_minutes: this.numberLeaf(
          "budgets.default_max_minutes",
          budgets.default_max_minutes,
        ),
        max_concurrency: this.numberLeaf("budgets.max_concurrency", budgets.max_concurrency),
      },
      notifications: {
        slack_enabled: this.booleanLeaf("notifications.slack_enabled", notifications.slack_enabled),
        email_to: this.emailsLeaf("notifications.email_to", notifications.email_to),
      },
      policies: {
        flaky_quarantine_after: this.numberLeaf(
          "policies.flaky_quarantine_after",
          policies.flaky_quarantine_after,
        ),
      },
      overrides: [...this.overrides.keys()].sort(),
      secrets: Object.fromEntries(SECRET_NAMES.map((name) => [name, this.secretStatus(name)])),
    };
  }

  apply(leaves: readonly ParsedLeaf[]): void {
    for (const leaf of leaves) {
      const key = leaf.path.join(".");
      if (leaf.value === null) {
        this.overrides.delete(key);
      } else {
        this.overrides.set(key, leaf.value);
      }
    }
  }

  secretStatus(name: SecretName): SecretStatus {
    const record = this.secrets.get(name);
    if (record?.stored) {
      return {
        name,
        has_value: true,
        last_set_at: record.stored.at,
        last_set_by: record.stored.by,
        source: "db",
      };
    }
    if (record?.envProvided) {
      return { name, has_value: true, last_set_at: null, last_set_by: null, source: "env" };
    }
    return { name, has_value: false, last_set_at: null, last_set_by: null, source: null };
  }

  hasSecret(name: SecretName): boolean {
    return this.secretStatus(name).has_value;
  }

  markSecretSet(name: SecretName, userId: string, at: string): SecretStatus {
    const record = this.secrets.get(name);
    this.secrets.set(name, {
      envProvided: record?.envProvided ?? false,
      stored: { at, by: userId },
    });
    return this.secretStatus(name);
  }

  markSecretCleared(name: SecretName): void {
    const record = this.secrets.get(name);
    this.secrets.set(name, { envProvided: record?.envProvided ?? false, stored: null });
  }

  private readModel(role: ModelRole): SettingsRead["models"][string] {
    const fallback: ModelDefaults = this.defaults.models[role];
    const prefix = `models.${role}`;
    const overridden = [...this.overrides.keys()].some((key) => key.startsWith(`${prefix}.`));
    return {
      model: this.stringLeaf(`${prefix}.model`, fallback.model),
      effort: this.effortLeaf(`${prefix}.effort`, fallback.effort),
      max_usd: this.numberLeaf(`${prefix}.max_usd`, fallback.max_usd),
      timeout_seconds: this.numberLeaf(`${prefix}.timeout_seconds`, fallback.timeout_seconds),
      source: overridden ? "db" : "env",
    };
  }

  private numberLeaf(path: string, fallback: number): number {
    const value = this.overrides.get(path);
    return typeof value === "number" ? value : fallback;
  }

  private stringLeaf(path: string, fallback: string): string {
    const value = this.overrides.get(path);
    return typeof value === "string" ? value : fallback;
  }

  private booleanLeaf(path: string, fallback: boolean): boolean {
    const value = this.overrides.get(path);
    return typeof value === "boolean" ? value : fallback;
  }

  private emailsLeaf(path: string, fallback: readonly string[]): string[] {
    const value = this.overrides.get(path);
    return Array.isArray(value) ? [...value] : [...fallback];
  }

  private nullableStringLeaf(path: string, fallback: string | null): string | null {
    const value = this.overrides.get(path);
    return typeof value === "string" ? value : fallback;
  }

  private effortLeaf(path: string, fallback: ModelDefaults["effort"]): ModelDefaults["effort"] {
    const value = this.overrides.get(path);
    return value === "minimal" || value === "low" || value === "medium" || value === "high"
      ? value
      : fallback;
  }
}
