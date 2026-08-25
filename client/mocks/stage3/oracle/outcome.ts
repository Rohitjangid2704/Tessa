import { renderSentence } from "./params";
import { buildRows } from "./rows";
import type { OracleOutcome, OracleTemplateRecord } from "./store";

export const FAULT_ERROR_MESSAGE = "The oracle worker could not reach the truth database";
export const FAULT_ERROR_DURATION_MS = 1500;

export interface OutcomeOptions {
  forceError: boolean;
}

export function computeOutcome(
  template: OracleTemplateRecord,
  params: Record<string, unknown>,
  options: OutcomeOptions,
): OracleOutcome {
  const { behavior } = template;
  if (options.forceError) {
    return {
      status: "error",
      rows: [],
      rowsTruncated: false,
      sentence: null,
      error: FAULT_ERROR_MESSAGE,
      durationMs: FAULT_ERROR_DURATION_MS,
    };
  }
  if (behavior.errorMessage !== undefined) {
    return {
      status: "error",
      rows: [],
      rowsTruncated: false,
      sentence: null,
      error: behavior.errorMessage,
      durationMs: behavior.durationMs,
    };
  }
  const built = buildRows(behavior.rows, params);
  return {
    status: "ok",
    rows: built.rows,
    rowsTruncated: built.truncated,
    sentence: renderSentence(template.sentenceTemplate, params, built.rows),
    error: null,
    durationMs: behavior.durationMs,
  };
}
