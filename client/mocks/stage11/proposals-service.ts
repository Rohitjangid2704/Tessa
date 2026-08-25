import type {
  AuditVia,
  Plan,
  Proposal,
  ProposalItem,
  ProposalItemStatus,
  ProposalRisk,
} from "@/lib/api/types";
import { MockApiError, notFound, validationFailed } from "../factories/errors";
import { BodyReader, type Source } from "../stage1/body";
import type { TargetRecord } from "../stage1/store";
import {
  buildPlan,
  evaluatePlan,
  notReady,
  planEmpty,
  type ParsedPlanCreate,
} from "../stage2/plan-service";
import { nowIso } from "../stage2/support";
import { stableId } from "../stage2/ids";
import { coverageBus } from "../stage6/coverage-bus";
import { coverageStore } from "../stage6/coverage-store";
import type { CoverageCellState } from "../stage6/coverage-data";
import type { MockState } from "../state";
import type { MockUser } from "../types";
import { auditStore } from "./audit-store";
import {
  PROPOSAL_CHOICES,
  PROPOSAL_ITEMS_MAX,
  PROPOSAL_NOTE_MAX,
  type ProposalChoice,
  type ProposalItemRecord,
  type ProposalRecord,
} from "./proposals-data";
import { proposalsStore } from "./proposals-store";
import { checkProposalYaml } from "./proposals-yaml";

export const PROPOSAL_UPDATED = "proposal.updated";
const CARRIED: readonly ProposalItemRecord["status"][] = ["selected", "declined", "authored"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RISK_RANK: Readonly<Record<ProposalRisk, number>> = { low: 0, medium: 1, high: 2 };
const DEPTH_RANK = { smoke: 0, standard: 1, deep: 2 } as const;
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ipt_[A-Za-z0-9_-]{43}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function cellsOf(state: MockState, target: TargetRecord): readonly CoverageCellState[] {
  const latest = state.stageOne.latestValidBundle(target.id);
  return latest === undefined ? [] : coverageStore.datasetFor(target, latest).cells;
}

function matchesInterface(item: ProposalItemRecord, interfaceId: string): boolean {
  return item.interface_id === null || item.interface_id === interfaceId;
}

export function cellsForItem(
  item: ProposalItemRecord,
  cells: readonly CoverageCellState[],
): CoverageCellState[] {
  return cells
    .filter(
      (cell) =>
        item.feature_ids.includes(cell.featureId) && matchesInterface(item, cell.interfaceId),
    )
    .sort(
      (left, right) =>
        left.featureId.localeCompare(right.featureId) ||
        left.role.localeCompare(right.role) ||
        left.interfaceId.localeCompare(right.interfaceId),
    );
}

function shownStatus(
  item: ProposalItemRecord,
  cells: readonly CoverageCellState[],
): ProposalItemStatus {
  if (item.status === "declined") {
    return "declined";
  }
  if (cells.length > 0 && cells.every((cell) => cell.status === "covered")) {
    return "covered";
  }
  return item.status;
}

export function viewItem(
  item: ProposalItemRecord,
  cells: readonly CoverageCellState[],
): ProposalItem {
  const mapped = cellsForItem(item, cells);
  return {
    ...item,
    reasons: item.reasons.map((reason) => ({ ...reason })),
    feature_ids: [...item.feature_ids],
    needs: [...item.needs],
    estimate: item.estimate === null ? null : { ...item.estimate },
    scenario_ids: [...item.scenario_ids],
    status: shownStatus(item, mapped),
    cell_ids: mapped.map((cell) => cell.id),
  };
}

export function viewProposal(
  state: MockState,
  target: TargetRecord,
  record: ProposalRecord,
): Proposal {
  const latest = state.stageOne.latestValidBundle(target.id);
  const cells = cellsOf(state, target);
  return {
    id: record.id,
    target_id: record.target_id,
    bundle_id: record.bundle_id,
    commit_sha: record.commit_sha,
    branch: record.branch,
    generated_at: record.generated_at,
    source: record.source,
    created_by: record.created_by,
    created_at: record.created_at,
    stale: latest !== undefined && record.bundle_id !== latest.bundle.id,
    items: record.items.map((item) => viewItem(item, cells)),
  };
}

export function readProposal(state: MockState, target: TargetRecord): Proposal {
  const record = proposalsStore.current(target.id, state);
  if (record === undefined) {
    throw notFound("The target has no test proposal yet");
  }
  return viewProposal(state, target, record);
}

export function publishProposalUpdated(
  targetId: string,
  proposalId: string,
  item: { id: string; status: ProposalItemStatus } | null,
): void {
  coverageBus.publish(targetId, PROPOSAL_UPDATED, {
    target_id: targetId,
    proposal_id: proposalId,
    item_id: item?.id ?? null,
    status: item?.status ?? null,
  });
}

export interface ParsedItemUpdate {
  status: ProposalChoice;
  note: string | null | undefined;
}

export function parseItemUpdate(raw: Source): ParsedItemUpdate {
  const reader = new BodyReader(raw);
  const status = reader.enum("status", PROPOSAL_CHOICES, { required: true });
  const note = reader.string("note", {
    required: false,
    nullable: true,
    max: PROPOSAL_NOTE_MAX,
  });
  if (reader.details.length > 0 || typeof status !== "string") {
    throw validationFailed(reader.details);
  }
  return { status, note };
}

export function updateItem(
  state: MockState,
  user: MockUser,
  via: AuditVia,
  itemId: string,
  update: ParsedItemUpdate,
): ProposalItem {
  const found = proposalsStore.findItem(itemId, state);
  if (found === undefined) {
    throw notFound("Proposal item not found");
  }
  if (found === "retired") {
    throw new MockApiError(
      409,
      "conflict",
      "The item belongs to an older proposal; reload the proposal of the target",
    );
  }
  const { record, item } = found;
  if (item.status === "authored") {
    throw new MockApiError(409, "conflict", "The item is already authored", [
      {
        loc: ["body", "status"],
        code: "item_authored",
        message: "Scenarios were already authored for the item, so it can no longer be changed",
      },
    ]);
  }
  const previous = item.status;
  item.status = update.status;
  if (update.note !== undefined) {
    const trimmed = update.note === null ? "" : update.note.trim();
    item.note = trimmed === "" ? null : trimmed;
  } else if (update.status === "proposed") {
    item.note = null;
  }
  if (update.status === "proposed") {
    item.selected_by = null;
    item.selected_at = null;
  } else {
    item.selected_by = user.id;
    item.selected_at = nowIso();
  }
  auditStore.record({
    action: "proposal_item_changed",
    subjectType: "proposal",
    subjectId: item.id,
    actorUserId: user.id,
    via,
    detail: { item: item.key, from: previous, to: item.status },
  });
  const target = state.stageOne.findTarget(record.target_id);
  const view = viewItem(item, target === undefined ? [] : cellsOf(state, target));
  publishProposalUpdated(record.target_id, record.id, { id: item.id, status: item.status });
  return view;
}

export function putProposal(
  state: MockState,
  user: MockUser,
  via: AuditVia,
  target: TargetRecord,
  rawYaml: string,
): Proposal {
  const latest = state.stageOne.latestValidBundle(target.id);
  if (latest === undefined) {
    throw notReady(
      [{ loc: ["bundle"], code: "bundle_missing", message: "The target has no valid bundle" }],
      "The target has no valid bundle yet; upload one first",
    );
  }
  if (SECRET_PATTERN.test(rawYaml)) {
    throw new MockApiError(
      422,
      "bundle_contains_secret",
      "proposal.yaml contains an apparent secret; replace it with a placeholder",
      [
        {
          loc: ["proposal.yaml"],
          code: "secret_detected",
          message: "An apparent secret was found",
        },
      ],
    );
  }
  const dataset = coverageStore.datasetFor(target, latest);
  const featureIds = new Set([
    ...dataset.rows.map((row) => row.feature_id),
    ...latest.features.map((feature) => feature.feature_id),
  ]);
  const check = checkProposalYaml(rawYaml, {
    targetTokens: [target.targetToken, target.previousTargetToken].filter(
      (token): token is string => token !== null,
    ),
    featureIds,
  });
  if (check.errors.length > 0) {
    throw new MockApiError(
      422,
      "proposal_invalid",
      `proposal.yaml is not valid: ${check.errors.length} error(s)`,
      check.errors.slice(0, 20),
    );
  }
  const previous = proposalsStore.current(target.id, state);
  const earlier = new Map((previous?.items ?? []).map((item) => [item.key, item]));
  const now = nowIso();
  const proposalId = stableId("proposal_put", target.id, now, check.items.length);
  const items: ProposalItemRecord[] = check.items.map((item) => {
    const inherited = earlier.get(item.key);
    const carry = inherited !== undefined && CARRIED.includes(inherited.status) ? inherited : null;
    return {
      id: stableId("proposal_item_put", proposalId, item.key),
      key: item.key,
      title: item.title,
      area: item.area,
      feature_ids: item.feature_ids,
      interface_id: item.interface_id,
      kind: item.kind,
      risk: item.risk,
      reasons: item.reasons,
      needs: item.needs,
      depth: item.depth,
      estimate: item.estimate,
      confidence: item.confidence,
      evidence: item.evidence,
      status: carry === null ? "proposed" : carry.status,
      note: carry?.note ?? null,
      selected_by: carry?.selected_by ?? null,
      selected_at: carry?.selected_at ?? null,
      scenario_ids: carry === null ? [] : [...carry.scenario_ids],
    };
  });
  const record: ProposalRecord = {
    id: proposalId,
    target_id: target.id,
    bundle_id: latest.bundle.id,
    commit_sha: check.commit ?? latest.bundle.commit_sha ?? null,
    branch: check.branch ?? latest.bundle.branch ?? null,
    generated_at: check.generatedAt ?? now,
    source: "put",
    created_by: user.id,
    created_at: now,
    items,
  };
  proposalsStore.replace(record);
  auditStore.record({
    action: "proposal_put",
    subjectType: "proposal",
    subjectId: record.id,
    actorUserId: user.id,
    via,
    detail: {
      items: items.length,
      commit: record.commit_sha,
      bundle_version: latest.bundle.version,
    },
  });
  publishProposalUpdated(target.id, record.id, null);
  return viewProposal(state, target, record);
}

function interfaceModeOf(items: readonly ProposalItemRecord[]) {
  const browser = items.some((item) => item.kind === "browser");
  const other = items.some((item) => item.kind !== "browser");
  if (browser && other) {
    return "both" as const;
  }
  return browser ? ("browser_only" as const) : ("api_only" as const);
}

export interface ParsedPlanRequest {
  name: string | null;
  itemIds: string[] | null;
}

export function parsePlanRequest(raw: Source): ParsedPlanRequest {
  const reader = new BodyReader(raw);
  const name = reader.string("name", {
    required: false,
    nullable: true,
    min: 1,
    max: 120,
    strip: true,
  });
  const itemIds = reader.stringList("item_ids", { nullable: true, maxItems: PROPOSAL_ITEMS_MAX });
  itemIds?.forEach((id, index) => {
    if (!UUID_PATTERN.test(id)) {
      reader.details.push({
        loc: ["body", "item_ids", index],
        code: "uuid_parsing",
        message: "Input should be a valid UUID",
      });
    }
  });
  if (itemIds !== null && itemIds !== undefined && itemIds.length === 0) {
    reader.issue(
      "item_ids",
      "too_short",
      "List should have at least 1 item after validation, not 0",
    );
  }
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  return { name: name ?? null, itemIds: itemIds ?? null };
}

export function planFromProposal(
  state: MockState,
  user: MockUser,
  target: TargetRecord,
  request: ParsedPlanRequest,
): Plan {
  const record = proposalsStore.current(target.id, state);
  if (record === undefined) {
    throw notFound("The target has no test proposal yet");
  }
  let chosen: ProposalItemRecord[];
  if (request.itemIds === null) {
    chosen = record.items.filter((item) => item.status === "selected");
  } else {
    const wanted = [...new Set(request.itemIds.map((id) => id.toLowerCase()))];
    const missing = wanted.filter((id) => !record.items.some((item) => item.id === id));
    if (missing.length > 0) {
      throw validationFailed(
        missing.map((id) => ({
          loc: ["body", "item_ids"],
          code: "item_not_found",
          message: `Item ${id} is not part of the current proposal`,
        })),
      );
    }
    chosen = wanted.flatMap((id) => record.items.filter((item) => item.id === id));
  }
  if (chosen.length === 0) {
    throw validationFailed([
      {
        loc: ["body", "item_ids"],
        code: "nothing_selected",
        message: "Select at least one item of the proposal before planning",
      },
    ]);
  }
  const depth = chosen.reduce<keyof typeof DEPTH_RANK>(
    (best, item) => (DEPTH_RANK[item.depth] > DEPTH_RANK[best] ? item.depth : best),
    "smoke",
  );
  const parsed: ParsedPlanCreate = {
    targetId: target.id,
    bundleId: null,
    name: request.name ?? `Proposal ${nowIso().slice(0, 10)}`,
    saved: true,
    selection: {
      feature_ids: [...new Set(chosen.flatMap((item) => item.feature_ids))].sort(),
      area_ids: [],
      roles: [],
      interface_mode: interfaceModeOf(chosen),
      depth,
      k: 1,
    },
    includeApiFuzz: false,
  };
  const evaluation = evaluatePlan(state, parsed);
  if (evaluation.expansion.cells.length === 0) {
    throw planEmpty();
  }
  const plan = buildPlan(state.stageTwo, parsed, evaluation, user.id, nowIso());
  state.stageTwo.addPlan(plan);
  return structuredClone(plan);
}

export function riskByFeature(
  state: MockState,
  targetId: string,
): ReadonlyMap<string, ProposalRisk> {
  const record = proposalsStore.current(targetId, state);
  const risks = new Map<string, ProposalRisk>();
  for (const item of record?.items ?? []) {
    if (item.status === "declined") {
      continue;
    }
    for (const featureId of item.feature_ids) {
      const known = risks.get(featureId);
      if (known === undefined || RISK_RANK[item.risk] > RISK_RANK[known]) {
        risks.set(featureId, item.risk);
      }
    }
  }
  return risks;
}
