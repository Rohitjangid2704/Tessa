import type { OracleApproval, OracleLanguage, OracleResultStatus } from "@/lib/api/types";
import { newId } from "../../factories/ids";
import type { OracleBehavior } from "../../fixtures/oracle-templates";
import { seedOracle } from "./seed";
import type { OracleRow } from "./rows";

export type OracleSeed = "default" | "empty";

export interface OracleTemplateRecord {
  id: string;
  targetId: string;
  name: string;
  featureIds: string[];
  language: OracleLanguage;
  source: string;
  paramsSchema: Record<string, unknown>;
  sentenceTemplate: string;
  readOnlyVerified: boolean;
  approval: OracleApproval;
  behavior: OracleBehavior;
}

export interface OracleOutcome {
  status: Exclude<OracleResultStatus, "pending">;
  rows: OracleRow[];
  rowsTruncated: boolean;
  sentence: string | null;
  error: string | null;
  durationMs: number;
}

export interface OracleResultRecord {
  id: string;
  templateId: string;
  params: Record<string, unknown>;
  startedAtMs: number;
  settleAtMs: number;
  outcome: OracleOutcome;
}

export interface OracleConfiguration {
  settleMs: number | null;
}

export class OracleStore {
  templates: OracleTemplateRecord[] = [];
  results: OracleResultRecord[] = [];
  settleOverrideMs: number | null = null;

  constructor() {
    this.reset("default");
  }

  reset(seed: OracleSeed = "default"): void {
    this.templates = [];
    this.results = [];
    this.settleOverrideMs = null;
    seedOracle(this, seed);
  }

  configure(configuration: OracleConfiguration): void {
    this.settleOverrideMs = configuration.settleMs;
  }

  findTemplate(id: string): OracleTemplateRecord | undefined {
    return this.templates.find((template) => template.id === id);
  }

  findResult(id: string): OracleResultRecord | undefined {
    return this.results.find((result) => result.id === id);
  }

  resultsOf(templateId: string): OracleResultRecord[] {
    return this.results.filter((result) => result.templateId === templateId);
  }

  addResult(input: Omit<OracleResultRecord, "id">): OracleResultRecord {
    const record: OracleResultRecord = { id: newId(input.startedAtMs), ...input };
    this.results.push(record);
    return record;
  }
}
