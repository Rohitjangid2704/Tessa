import { http } from "msw";
import type { FindingSummary } from "@/lib/api/types";
import { MockApiError, notFound, validationFailed } from "../factories/errors";
import { toFindingSummary } from "../factories/finding";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { pathUuid } from "../stage1/support";
import { explanationsStore } from "../stage11/explanations-store";
import { findingDetailStore } from "../stage5/finding-detail-store";
import type { FindingPatch } from "../stage5/findings-store";
import {
  findingsStore,
  FINDING_CLASSES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  SEVERITY_RANK,
} from "../stage5/support";
import { userMayMove } from "../stage5/transitions";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

export const TICKET_URL_MAX = 2048;
export const KNOWN_GAP_REASON_MAX = 500;
export const QUERY_TEXT_MAX = 200;

const FINDING_PAGE: PageSpec<FindingSummary> = {
  sortKeys: {
    last_seen_at: { kind: "timestamp", value: (row) => row.last_seen_at },
    first_seen_at: { kind: "timestamp", value: (row) => row.first_seen_at },
    severity: { kind: "number", value: (row) => SEVERITY_RANK[row.severity] },
    occurrence_count: { kind: "number", value: (row) => row.occurrence_count },
  },
  defaultSort: "-last_seen_at",
  getId: (row) => row.id,
};

function matchesText(row: FindingSummary, text: string): boolean {
  const needle = text.toLowerCase();
  return [row.title, row.fingerprint, row.invariant_id ?? ""].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

async function listFindings(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const statuses = query.enumList("status", FINDING_STATUSES);
  const severities = query.enumList("severity", FINDING_SEVERITIES);
  const classes = query.enumList("class", FINDING_CLASSES);
  const invariantIds = query.stringList("invariant_id");
  const runId = query.uuid("run_id");
  const scenarioId = query.uuid("scenario_id");
  const fingerprint = query.text("fingerprint", { max: QUERY_TEXT_MAX });
  const text = query.text("q", { max: QUERY_TEXT_MAX });
  const paginate = readPage(query, FINDING_PAGE);
  query.finish();

  const wantedRun = runId?.toLowerCase();
  const rows = findingsStore(context)
    .records.filter(
      ({ finding, runIds }) =>
        (targetId === undefined || finding.target_id === targetId.toLowerCase()) &&
        (wantedRun === undefined ||
          runIds.includes(wantedRun) ||
          finding.first_seen_run_id === wantedRun ||
          finding.last_seen_run_id === wantedRun) &&
        (scenarioId === undefined || finding.scenario_id === scenarioId.toLowerCase()) &&
        (fingerprint === undefined || finding.fingerprint === fingerprint),
    )
    .map(({ finding }) => toFindingSummary(finding))
    .filter((row) => statuses === undefined || statuses.includes(row.status))
    .filter((row) => severities === undefined || severities.includes(row.severity))
    .filter((row) => classes === undefined || classes.includes(row.class))
    .filter(
      (row) =>
        invariantIds === undefined ||
        (row.invariant_id !== null && invariantIds.includes(row.invariant_id)),
    )
    .filter((row) => text === undefined || text.trim() === "" || matchesText(row, text.trim()));
  return jsonResponse(paginate(rows));
}

async function readFinding(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const finding = findingsStore(context).find(pathUuid(context, "finding_id"));
  if (finding === undefined) {
    throw notFound("Finding not found");
  }
  return jsonResponse({
    ...finding,
    latest_explanation: findingDetailStore(context).latestExplanationOf(
      finding,
      explanationsStore.structured,
    ),
  });
}

function readTicketUrl(body: BodyReader): string | null | undefined {
  const value = body.string("ticket_url", { required: false, nullable: true, max: TICKET_URL_MAX });
  if (typeof value !== "string") {
    return value;
  }
  let protocol = "";
  try {
    protocol = new URL(value).protocol;
  } catch {
    body.issue("ticket_url", "url_parsing", "Input should be a valid URL");
    return undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") {
    body.issue("ticket_url", "url_scheme", "URL scheme should be 'http' or 'https'");
    return undefined;
  }
  return value;
}

async function updateFinding(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const findingId = pathUuid(context, "finding_id");
  const body = new BodyReader(parseJsonObject(await context.request.text()));
  const status = body.enum("status", FINDING_STATUSES, { required: false, nullable: true });
  const severity = body.enum("severity", FINDING_SEVERITIES, { required: false, nullable: true });
  const ticketUrl = readTicketUrl(body);
  const reason = body.string("known_gap_reason", {
    required: false,
    nullable: true,
    max: KNOWN_GAP_REASON_MAX,
    strip: true,
  });
  if (status === "known_gap" && (reason === undefined || reason === null || reason === "")) {
    body.issue(
      "known_gap_reason",
      "value_error",
      "Value error, known_gap_reason is required when status is known_gap",
    );
  }
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }

  const store = findingsStore(context);
  const current = store.find(findingId);
  if (current === undefined) {
    throw notFound("Finding not found");
  }

  const patch: FindingPatch = {};
  if (status !== undefined && status !== null && status !== current.status) {
    if (!userMayMove(current.status, status)) {
      throw new MockApiError(
        409,
        "conflict",
        `A finding cannot move from ${current.status} to ${status}`,
        [
          {
            loc: ["body", "status"],
            code: "transition_not_allowed",
            message: `Moving from ${current.status} to ${status} is not allowed`,
          },
        ],
      );
    }
    patch.status = status;
  }
  if (severity !== undefined && severity !== null) {
    patch.severity = severity;
  }
  if (ticketUrl !== undefined) {
    patch.ticket_url = ticketUrl;
  }
  if (reason !== undefined) {
    patch.known_gap_reason = reason === "" ? null : reason;
  }
  return jsonResponse(store.update(findingId, patch).finding);
}

export const findingHandlers = [
  http.get("*/api/v1/findings", api(listFindings)),
  http.get("*/api/v1/findings/:finding_id", api(readFinding)),
  http.patch("*/api/v1/findings/:finding_id", api(updateFinding)),
];
