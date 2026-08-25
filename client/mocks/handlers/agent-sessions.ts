import { http } from "msw";
import type { AgentSession } from "@/lib/api/types";
import { forbidden, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { pathUuid, requireTarget } from "../stage1/support";
import {
  AGENT_SESSION_LABEL_MAX,
  AGENT_SESSION_SUMMARY_MAX,
  buildAgentSession,
} from "../stage11/agent-sessions-data";
import { AGENT_SESSION_PAGE } from "../stage11/agent-sessions-service";
import { agentSessionsStore } from "../stage11/agent-sessions-store";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const CLAUDE_SESSION_ID_MAX = 200;
const PLUGIN_VERSION_MAX = 40;

async function listSessions(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const userId = query.uuid("user_id");
  const active = context.url.searchParams.has("active") ? query.boolean("active", true) : undefined;
  const paginate = readPage(query, AGENT_SESSION_PAGE);
  query.finish();
  const rows = agentSessionsStore
    .all()
    .filter((session) => targetId === undefined || session.target_id === targetId)
    .filter((session) => userId === undefined || session.user_id === userId)
    .filter((session) => active === undefined || (session.ended_at === null) === active);
  return jsonResponse(paginate(rows));
}

async function createSession(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const body = new BodyReader(parseJsonObject(await context.request.text()));
  const claudeSessionId = body.string("claude_session_id", {
    required: true,
    min: 1,
    max: CLAUDE_SESSION_ID_MAX,
  });
  const cwdLabel = body.string("cwd_label", {
    required: true,
    min: 1,
    max: AGENT_SESSION_LABEL_MAX,
  });
  const pluginVersion = body.string("plugin_version", {
    required: true,
    min: 1,
    max: PLUGIN_VERSION_MAX,
  });
  const targetId = body.uuid("target_id", { required: false, nullable: true });
  if (
    body.details.length > 0 ||
    typeof claudeSessionId !== "string" ||
    typeof cwdLabel !== "string" ||
    typeof pluginVersion !== "string"
  ) {
    throw validationFailed(body.details);
  }
  if (typeof targetId === "string") {
    requireTarget(context, targetId);
  }
  const session: AgentSession = buildAgentSession(Date.now(), {
    user_id: user.id,
    claude_session_id: claudeSessionId,
    cwd_label: cwdLabel,
    plugin_version: pluginVersion,
    target_id: typeof targetId === "string" ? targetId : null,
  });
  agentSessionsStore.add(session);
  agentSessionsStore.announce(session);
  return jsonResponse(session, { status: 201 });
}

async function updateSession(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const session = agentSessionsStore.find(pathUuid(context, "agent_session_id"));
  if (session === undefined) {
    throw notFound("Agent session not found");
  }
  if (session.user_id !== user.id && user.role !== "admin") {
    throw forbidden("Only the owner of an agent session can change it");
  }
  const raw = parseJsonObject(await context.request.text());
  const body = new BodyReader(raw);
  const targetId = body.uuid("target_id", { required: false, nullable: true });
  const summary = body.string("summary", {
    required: false,
    nullable: true,
    max: AGENT_SESSION_SUMMARY_MAX,
  });
  const endedAt = body.string("ended_at", { required: false, nullable: true });
  if (typeof endedAt === "string" && Number.isNaN(Date.parse(endedAt))) {
    body.issue("ended_at", "datetime_from_date_parsing", "Input should be a valid datetime");
  }
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  if (typeof targetId === "string") {
    requireTarget(context, targetId);
  }
  if (targetId !== undefined) {
    session.target_id = targetId;
  }
  if (summary !== undefined) {
    session.summary = summary;
  }
  if (endedAt !== undefined) {
    session.ended_at = endedAt;
  }
  agentSessionsStore.announce(session);
  return jsonResponse({ ...session });
}

export const agentSessionHandlers = [
  http.get("*/api/v1/agent-sessions", api(listSessions)),
  http.post("*/api/v1/agent-sessions", api(createSession)),
  http.patch("*/api/v1/agent-sessions/:agent_session_id", api(updateSession)),
];
