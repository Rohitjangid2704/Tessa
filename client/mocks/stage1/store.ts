import type { components } from "@/lib/api/schema";
import type { Bundle } from "../factories/bundles";
import type { CatalogInterface, CatalogItem, CatalogRole } from "../factories/catalog";
import type { HealthReport, HealthState } from "../factories/environment";
import { buildLimits, type LimitsRead } from "../factories/limits";
import type { PromptIssue } from "../factories/prompts";
import type { DeclaredVariable } from "../fixtures/gracie-env";
import { seedStageOne, type StageOneSeed } from "./seed";

type Schemas = components["schemas"];

export interface TargetRecord {
  id: string;
  name: string;
  slug: string;
  appKind: Schemas["AppKind"];
  tier: Schemas["TargetTier"];
  allowProduction: boolean;
  targetToken: string;
  previousTargetToken: string | null;
  hints: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
  archivedAt: string | null;
  healthReport: HealthReport | null;
}

export interface BundleFileRecord {
  path: string;
  content: string;
  size_bytes: number;
  sha256: string;
  truncated: boolean;
}

export interface TruthSourceRecord {
  id: string;
  connection_env: string;
  kind: string;
  dialect: string;
}

export interface BundleRecord {
  bundle: Bundle;
  features: CatalogItem[];
  roles: CatalogRole[];
  interfaces: CatalogInterface[];
  truthSources: TruthSourceRecord[];
  environment: DeclaredVariable[];
  files: BundleFileRecord[];
  sections: Record<string, unknown>;
}

export interface EnvironmentEntry {
  name: string;
  kind: Schemas["EnvVarKind"];
  secret: boolean;
  required: boolean;
  purpose: string;
  interface_ids: string[];
  value: string | null;
  stale: boolean;
  last_set_at: string | null;
  last_set_by: string | null;
  health: HealthState;
}

export class StageOneStore {
  targets: TargetRecord[] = [];
  bundles: BundleRecord[] = [];
  environments = new Map<string, EnvironmentEntry[]>();
  promptIssues: PromptIssue[] = [];
  limits: LimitsRead = buildLimits();

  constructor() {
    this.reset("gracie");
  }

  reset(seed: StageOneSeed = "gracie"): void {
    this.targets = [];
    this.bundles = [];
    this.environments = new Map();
    this.promptIssues = [];
    this.limits = buildLimits();
    seedStageOne(this, seed);
  }

  configureLimits(overrides: Partial<LimitsRead>): void {
    this.limits = { ...this.limits, ...overrides };
  }

  findTarget(id: string): TargetRecord | undefined {
    return this.targets.find((target) => target.id === id);
  }

  findTargetByToken(token: string): { target: TargetRecord; matchedPrevious: boolean } | null {
    for (const target of this.targets) {
      if (target.targetToken === token) {
        return { target, matchedPrevious: false };
      }
      if (target.previousTargetToken === token) {
        return { target, matchedPrevious: true };
      }
    }
    return null;
  }

  bundlesOf(targetId: string): BundleRecord[] {
    return this.bundles
      .filter((record) => record.bundle.target_id === targetId)
      .sort((left, right) => left.bundle.version - right.bundle.version);
  }

  findBundle(id: string): BundleRecord | undefined {
    return this.bundles.find((record) => record.bundle.id === id);
  }

  latestBundle(targetId: string): BundleRecord | undefined {
    return this.bundlesOf(targetId).at(-1);
  }

  latestValidBundle(targetId: string): BundleRecord | undefined {
    return this.bundlesOf(targetId)
      .filter((record) => record.bundle.validation_status === "valid")
      .at(-1);
  }

  environmentOf(targetId: string): EnvironmentEntry[] {
    const existing = this.environments.get(targetId);
    if (existing !== undefined) {
      return existing;
    }
    const created: EnvironmentEntry[] = [];
    this.environments.set(targetId, created);
    return created;
  }
}
