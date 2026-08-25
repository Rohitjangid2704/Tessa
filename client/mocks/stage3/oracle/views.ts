import type { OracleResult, OracleTemplate } from "@/lib/api/types";
import type { StageOneStore } from "../../stage1/store";
import type { OracleResultRecord, OracleTemplateRecord } from "./store";

const NO_BUNDLE_ID = "00000000-0000-0000-0000-000000000000";

export function bundleIdOfTemplate(
  stageOne: StageOneStore,
  template: OracleTemplateRecord,
): string | null {
  return stageOne.latestValidBundle(template.targetId)?.bundle.id ?? null;
}

export function toOracleTemplate(
  stageOne: StageOneStore,
  template: OracleTemplateRecord,
): OracleTemplate {
  return {
    id: template.id,
    bundle_id: bundleIdOfTemplate(stageOne, template) ?? NO_BUNDLE_ID,
    name: template.name,
    feature_ids: [...template.featureIds],
    language: template.language,
    source: template.source,
    params_schema: structuredClone(template.paramsSchema),
    sentence_template: template.sentenceTemplate,
    read_only_verified: template.readOnlyVerified,
    approval: template.approval,
  };
}

export function toOracleResult(record: OracleResultRecord, nowMs: number): OracleResult {
  if (nowMs < record.settleAtMs) {
    return {
      id: record.id,
      oracle_template_id: record.templateId,
      params: structuredClone(record.params),
      status: "pending",
      rows: [],
      rows_truncated: false,
      sentence: null,
      error: null,
      duration_ms: null,
      executed_at: null,
    };
  }
  const { outcome } = record;
  return {
    id: record.id,
    oracle_template_id: record.templateId,
    params: structuredClone(record.params),
    status: outcome.status,
    rows: structuredClone(outcome.rows),
    rows_truncated: outcome.rowsTruncated,
    sentence: outcome.sentence,
    error: outcome.error,
    duration_ms: outcome.durationMs,
    executed_at: new Date(record.settleAtMs).toISOString(),
  };
}
