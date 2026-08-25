import { http } from "msw";
import { notFound } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { pathUuid } from "../stage1/support";
import { requireRunEntry, stageTwo, VERDICT_STATUSES } from "../stage2/support";
import type { RunEntry } from "../stage2/store";
import { buildRunDiff, type DiffSide } from "../stage5/diff";
import { INVARIANT_PACK_ORDER } from "../stage5/invariant-catalog";
import { buildInvariantResults, buildRunStats, OPEN_FINDING_STATUSES } from "../stage5/stats";
import { findingsStore } from "../stage5/support";
import type { InvariantResult } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const INVARIANT_RESULT_PAGE: PageSpec<InvariantResult> = {
  sortKeys: {
    created_at: { kind: "timestamp", value: (row) => row.created_at },
    invariant_id: { kind: "text", value: (row) => row.invariant_id },
    status: { kind: "text", value: (row) => row.status },
  },
  defaultSort: "invariant_id",
  getId: (row) => row.id,
};

export function openFindingsOf(context: ApiContext, runId: string): number {
  return findingsStore(context).records.filter(
    (record) =>
      record.runIds.includes(runId) && OPEN_FINDING_STATUSES.includes(record.finding.status),
  ).length;
}

export function sideOf(context: ApiContext, entry: RunEntry): DiffSide {
  return {
    entry,
    rows: stageTwo(context).scenariosOfRun(entry.run.id),
    openFindings: openFindingsOf(context, entry.run.id),
  };
}

async function readRunStats(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  new QueryReader(context.url.searchParams).finish();
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  const side = sideOf(context, entry);
  return jsonResponse(buildRunStats(side.entry, side.rows, side.openFindings));
}

async function listRunInvariants(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  const query = new QueryReader(context.url.searchParams);
  const statuses = query.enumList("status", VERDICT_STATUSES);
  const invariantIds = query.stringList("invariant_id");
  const packs = query.enumList("pack", INVARIANT_PACK_ORDER);
  const paginate = readPage(query, INVARIANT_RESULT_PAGE);
  query.finish();
  const rows = buildInvariantResults(entry, stageTwo(context).scenariosOfRun(entry.run.id))
    .filter((result) => statuses === undefined || statuses.includes(result.status))
    .filter(
      (result) => invariantIds === undefined || invariantIds.includes(result.invariant_id),
    )
    .filter((result) => packs === undefined || packs.includes(result.pack));
  return jsonResponse(paginate(rows));
}

export function previousCompletedRun(context: ApiContext, entry: RunEntry): RunEntry | undefined {
  const { plan_id: planId, created_at: createdAt } = entry.run;
  if (planId === null) {
    return undefined;
  }
  return stageTwo(context)
    .runs.filter(
      (candidate) =>
        candidate.run.id !== entry.run.id &&
        candidate.run.plan_id === planId &&
        candidate.run.status === "completed" &&
        Date.parse(candidate.run.created_at) < Date.parse(createdAt),
    )
    .sort(
      (left, right) => Date.parse(right.run.created_at) - Date.parse(left.run.created_at),
    )[0];
}

async function readRunDiff(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  const query = new QueryReader(context.url.searchParams);
  const againstId = query.uuid("against");
  query.finish();
  const against =
    againstId === undefined
      ? previousCompletedRun(context, entry)
      : requireRunEntry(context, againstId.toLowerCase());
  if (against === undefined) {
    throw notFound("No earlier completed run of this plan to compare with");
  }
  return jsonResponse(buildRunDiff(sideOf(context, entry), sideOf(context, against)));
}

export const runStatsHandlers = [
  http.get("*/api/v1/runs/:run_id/stats", api(readRunStats)),
  http.get("*/api/v1/runs/:run_id/invariants", api(listRunInvariants)),
  http.get("*/api/v1/runs/:run_id/diff", api(readRunDiff)),
];
