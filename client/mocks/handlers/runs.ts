import { SignJWT } from "jose";
import { http } from "msw";
import { WS_RUN_PATH_PREFIX } from "../config";
import { newId } from "../factories/ids";
import { secretKey } from "../factories/keys";
import { conflict, notFound } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { FieldValidator, parseJsonObject } from "../factories/validation";
import { requestRunCancel } from "../server/run-simulator";
import { hashParts, pathUuid, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { parseRunCreate, startSuiteRun } from "../stage2/run-service";
import { isPersonalTokenSecret } from "../stage11/tokens-data";
import { AGENT_TRIGGER } from "../stage11/subset-run";
import {
  BROWSER_SESSION_STATUSES,
  isTerminal,
  queryDateTime,
  RUN_KINDS,
  RUN_SCENARIO_STATUSES,
  RUN_STATUSES,
  requireRunEntry,
  stageTwo,
  VERDICT_STATUSES,
} from "../stage2/support";
import {
  toBrowserSession,
  toRun,
  toRunScenario,
  toRunScenarioSummary,
  toRunSummary,
} from "../stage2/views";
import type { RunEvent, RunEventPage, WsTicket } from "../types";
import type { RunScenarioSummary, RunSummary } from "@/lib/api/types";
import { api, jsonResponse, pathParam, requireUser, type ApiContext } from "./api";

const DEFAULT_EVENTS_LIMIT = 50;
const MAX_EVENTS_LIMIT = 200;
const MILLISECONDS_PER_SECOND = 1000;
const EVENT_ORDERS = ["asc", "desc"] as const;

function webSocketOrigin(origin: string): string {
  return origin.replace(/^http/, "ws");
}

async function listRunEvents(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const { searchParams } = context.url;
  const path = new FieldValidator("path");
  const query = path.forLocation("query");
  const runIdInput = path.requiredUuid({ run_id: pathParam(context, "run_id") }, "run_id");
  const afterSeq = query.queryInteger(searchParams.get("after_seq"), "after_seq", { min: 0 });
  const beforeSeq = query.queryInteger(searchParams.get("before_seq"), "before_seq", { min: 1 });
  const { runId, order, limit } = path.finish({
    runId: runIdInput,
    order: query.literal(searchParams.get("order"), "order", EVENT_ORDERS, "asc"),
    limit: query.queryInteger(searchParams.get("limit"), "limit", {
      min: 1,
      max: MAX_EVENTS_LIMIT,
      fallback: DEFAULT_EVENTS_LIMIT,
    }),
  });
  const types = searchParams.getAll("type");

  const run = context.state.findRun(runId);
  if (run === undefined) {
    throw notFound("Run not found");
  }

  const matching = run.events.filter(
    (event) =>
      (afterSeq === undefined || event.seq > afterSeq) &&
      (beforeSeq === undefined || event.seq < beforeSeq) &&
      (types.length === 0 || types.includes(event.type)),
  );
  const ordered: RunEvent[] = order === "asc" ? matching : [...matching].reverse();
  const page: RunEventPage = {
    items: ordered.slice(0, limit).map((event) => ({ ...event })),
    head_seq: run.events.length,
    has_more: ordered.length > limit,
  };
  return jsonResponse(page);
}

async function createWsTicket(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "viewer");
  const body = parseJsonObject(await context.request.text());
  const validator = new FieldValidator("body");
  const { runId } = validator.finish({ runId: validator.requiredUuid(body, "run_id") });
  if (context.state.findRun(runId) === undefined) {
    throw notFound("Run not found");
  }

  const { config } = context.state;
  const expiresAtSeconds =
    Math.floor(Date.now() / MILLISECONDS_PER_SECOND) + config.wsTicketTtlSeconds;
  const ticket = await new SignJWT({ typ: "ws-ticket", run_id: runId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setJti(newId())
    .setIssuedAt()
    .setExpirationTime(expiresAtSeconds)
    .sign(secretKey(config.wsTicketSigningKey));
  context.state.connections.ticketsIssued += 1;

  const response: WsTicket = {
    ticket,
    ws_url: `${webSocketOrigin(context.url.origin)}${WS_RUN_PATH_PREFIX}${runId}?ticket=${ticket}`,
    expires_at: new Date(expiresAtSeconds * MILLISECONDS_PER_SECOND).toISOString(),
  };
  return jsonResponse(response);
}

const RUN_PAGE: PageSpec<RunSummary> = {
  sortKeys: { created_at: { kind: "timestamp", value: (row) => row.created_at } },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

interface OrderedScenario {
  order: number;
  summary: RunScenarioSummary;
}

const RUN_SCENARIO_PAGE: PageSpec<OrderedScenario> = {
  sortKeys: {
    created_at: { kind: "number", value: (row) => row.order },
    status: { kind: "text", value: (row) => row.summary.status },
    role: { kind: "text", value: (row) => row.summary.role },
    interface_id: { kind: "text", value: (row) => row.summary.interface_id },
  },
  defaultSort: "created_at",
  getId: (row) => row.summary.id,
};

function startedWithPersonalToken(context: ApiContext): boolean {
  const header = context.request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token !== undefined && isPersonalTokenSecret(token);
}

async function createRun(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const parsed = parseRunCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({
      status: 202,
      body: startSuiteRun(context.state, user, parsed, {
        trigger: startedWithPersonalToken(context) ? AGENT_TRIGGER : undefined,
      }),
    }),
  );
}

async function listRuns(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const statuses = query.enumList("status", RUN_STATUSES);
  const kinds = query.enumList("kind", RUN_KINDS);
  const planId = query.uuid("plan_id");
  const runGroupId = query.uuid("run_group_id");
  const createdAfter = queryDateTime(query, "created_after");
  const createdBefore = queryDateTime(query, "created_before");
  const paginate = readPage(query, RUN_PAGE);
  query.finish();
  const rows = stageTwo(context)
    .runs.filter(({ run }) => targetId === undefined || run.target_id === targetId.toLowerCase())
    .filter(({ run }) => statuses === undefined || statuses.includes(run.status))
    .filter(({ run }) => kinds === undefined || kinds.includes(run.kind))
    .filter(({ run }) => planId === undefined || run.plan_id === planId.toLowerCase())
    .filter(({ run }) => runGroupId === undefined || run.run_group_id === runGroupId.toLowerCase())
    .filter(({ run }) => createdAfter === undefined || Date.parse(run.created_at) >= createdAfter)
    .filter(({ run }) => createdBefore === undefined || Date.parse(run.created_at) <= createdBefore)
    .map(toRunSummary);
  return jsonResponse(paginate(rows));
}

async function readRun(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(toRun(requireRunEntry(context, pathUuid(context, "run_id"))));
}

async function cancelRun(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  if (isTerminal(entry.run.status)) {
    throw conflict("run_not_cancelable", `The run is already ${entry.run.status}`);
  }
  requestRunCancel(stageTwo(context), entry.run.id);
  return jsonResponse(toRun(entry), { status: 202 });
}

async function listRunScenarios(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  const query = new QueryReader(context.url.searchParams);
  const statuses = query.enumList("status", RUN_SCENARIO_STATUSES);
  const verdicts = query.enumList("verdict", VERDICT_STATUSES);
  const families = query.stringList("family");
  const roles = query.stringList("role");
  const paginate = readPage(query, RUN_SCENARIO_PAGE);
  query.finish();
  const rows = stageTwo(context)
    .scenariosOfRun(entry.run.id)
    .map((row, order): OrderedScenario => ({ order, summary: toRunScenarioSummary(row) }))
    .filter(({ summary }) => statuses === undefined || statuses.includes(summary.status))
    .filter(
      ({ summary }) =>
        verdicts === undefined ||
        (summary.verdict !== null && verdicts.includes(summary.verdict.status)),
    )
    .filter(({ summary }) => families === undefined || families.includes(summary.family))
    .filter(({ summary }) => roles === undefined || roles.includes(summary.role));
  const page = paginate(rows);
  return jsonResponse({ ...page, items: page.items.map((item) => item.summary) });
}

async function listBrowserSessions(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  const query = new QueryReader(context.url.searchParams);
  const statuses = query.enumList("status", BROWSER_SESSION_STATUSES);
  query.finish();
  const items = stageTwo(context)
    .sessionsOfRun(entry.run.id)
    .filter((session) => statuses === undefined || statuses.includes(session.status))
    .map(toBrowserSession);
  return jsonResponse({ items });
}

async function readRunScenario(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const row = stageTwo(context).findRunScenario(pathUuid(context, "run_scenario_id"));
  if (row === undefined) {
    throw notFound("Run scenario not found");
  }
  return jsonResponse(toRunScenario(row));
}

export const runHandlers = [
  http.get("*/api/v1/runs/:run_id/events", api(listRunEvents)),
  http.post("*/api/v1/ws-tickets", api(createWsTicket)),
  http.post("*/api/v1/runs", api(createRun)),
  http.get("*/api/v1/runs", api(listRuns)),
  http.get("*/api/v1/runs/:run_id", api(readRun)),
  http.post("*/api/v1/runs/:run_id/cancel", api(cancelRun)),
  http.get("*/api/v1/runs/:run_id/scenarios", api(listRunScenarios)),
  http.get("*/api/v1/runs/:run_id/browser-sessions", api(listBrowserSessions)),
  http.get("*/api/v1/run-scenarios/:run_scenario_id", api(readRunScenario)),
];
