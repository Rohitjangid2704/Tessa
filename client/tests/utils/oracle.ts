import type { OracleResult, OracleTemplate } from "@/lib/api/types";
import { ORACLE_RESULT_IDS, ORACLE_TEMPLATE_IDS } from "@/mocks/fixtures/oracle-templates";
import { toOracleResult, toOracleTemplate } from "@/mocks/stage3/oracle/views";
import { mockState } from "@/mocks/state";

export { ORACLE_RESULT_IDS, ORACLE_TEMPLATE_IDS };

export function templateFixture(templateId: string): OracleTemplate {
  const record = mockState.stageThree.oracle.findTemplate(templateId);
  if (record === undefined) {
    throw new Error(`oracle template ${templateId} is not seeded`);
  }
  return toOracleTemplate(mockState.stageOne, record);
}

export function resultFixture(resultId: string): OracleResult {
  const record = mockState.stageThree.oracle.findResult(resultId);
  if (record === undefined) {
    throw new Error(`oracle result ${resultId} is not seeded`);
  }
  return toOracleResult(record, Date.now());
}

export function pendingResult(overrides: Partial<OracleResult> = {}): OracleResult {
  return {
    ...resultFixture(ORACLE_RESULT_IDS.openMaintenanceOk),
    status: "pending",
    rows: [],
    sentence: null,
    duration_ms: null,
    executed_at: null,
    ...overrides,
  };
}
