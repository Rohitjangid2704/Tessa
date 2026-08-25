import {
  ORACLE_RESULT_IDS,
  ORACLE_TEMPLATE_IDS,
  ORACLE_TEMPLATE_SEEDS,
} from "../../fixtures/oracle-templates";
import { STAGE_ONE_IDS } from "../../stage1/seed";
import { computeOutcome } from "./outcome";
import type { OracleSeed, OracleStore, OracleTemplateRecord } from "./store";

const DEFAULT_PARAMS = { tenant_id: "gracie-demo", as_of: "2026-10-01" };

interface HistorySeed {
  id: string;
  templateId: string;
  params: Record<string, unknown>;
  settledAt: string;
  forceError?: boolean;
}

const HISTORY: readonly HistorySeed[] = [
  {
    id: ORACLE_RESULT_IDS.openMaintenanceOk,
    templateId: ORACLE_TEMPLATE_IDS.openMaintenance,
    params: { ...DEFAULT_PARAMS, role: "front_desk", limit: 50, include_closed: false },
    settledAt: "2026-10-02T08:15:03.000Z",
  },
  {
    id: ORACLE_RESULT_IDS.openMaintenanceError,
    templateId: ORACLE_TEMPLATE_IDS.openMaintenance,
    params: { ...DEFAULT_PARAMS, role: "manager", limit: 50, include_closed: false },
    settledAt: "2026-10-02T08:02:41.000Z",
    forceError: true,
  },
  {
    id: ORACLE_RESULT_IDS.issueDetailOk,
    templateId: ORACLE_TEMPLATE_IDS.issueDetail,
    params: { tenant_id: "gracie-demo", issue_id: 1042 },
    settledAt: "2026-10-02T09:30:00.000Z",
  },
  {
    id: ORACLE_RESULT_IDS.staffRosterOk,
    templateId: ORACLE_TEMPLATE_IDS.staffRoster,
    params: { tenant_id: "gracie-demo" },
    settledAt: "2026-10-02T09:45:12.000Z",
  },
  {
    id: ORACLE_RESULT_IDS.legacyRoomStatusOk,
    templateId: ORACLE_TEMPLATE_IDS.legacyRoomStatus,
    params: { tenant_id: "gracie-demo" },
    settledAt: "2026-10-01T17:20:00.000Z",
  },
];

function toRecord(seed: (typeof ORACLE_TEMPLATE_SEEDS)[number]): OracleTemplateRecord {
  return {
    id: seed.id,
    targetId: STAGE_ONE_IDS.gracie,
    name: seed.name,
    featureIds: [...seed.featureIds],
    language: seed.language,
    source: seed.source,
    paramsSchema: structuredClone(seed.paramsSchema),
    sentenceTemplate: seed.sentenceTemplate,
    readOnlyVerified: seed.readOnlyVerified,
    approval: seed.approval,
    behavior: { ...seed.behavior },
  };
}

function seedHistory(store: OracleStore): void {
  for (const entry of HISTORY) {
    const template = store.findTemplate(entry.templateId);
    if (template === undefined) {
      continue;
    }
    const settledAtMs = Date.parse(entry.settledAt);
    const outcome = computeOutcome(template, entry.params, {
      forceError: entry.forceError === true,
    });
    store.results.push({
      id: entry.id,
      templateId: template.id,
      params: entry.params,
      startedAtMs: settledAtMs - outcome.durationMs,
      settleAtMs: settledAtMs,
      outcome,
    });
  }
}

export function seedOracle(store: OracleStore, seed: OracleSeed): void {
  if (seed === "empty") {
    return;
  }
  store.templates = ORACLE_TEMPLATE_SEEDS.map(toRecord);
  seedHistory(store);
}
