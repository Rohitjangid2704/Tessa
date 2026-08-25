import { AGENT_SESSION_HEADER } from "../config";
import { PERSONAL_TOKEN_WRITE } from "./audit-data";
import { agentSessionsStore } from "./agent-sessions-store";
import { auditStore } from "./audit-store";
import { isPersonalTokenSecret } from "./tokens-data";
import { tokensStore } from "./tokens-store";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_ID_PATTERN = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function personalTokenOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || rest.length > 0) {
    return null;
  }
  return isPersonalTokenSecret(token) ? token : null;
}

export function recordBearerWrite(request: Request, status: number): void {
  if (!WRITE_METHODS.has(request.method) || status >= 400) {
    return;
  }
  const secret = personalTokenOf(request);
  const userId = secret === null ? undefined : tokensStore.peekUserId(secret);
  if (userId === undefined) {
    return;
  }
  const url = new URL(request.url);
  const sessionHeader = request.headers.get(AGENT_SESSION_HEADER);
  const sessionId =
    sessionHeader !== null &&
    UUID_PATTERN.test(sessionHeader) &&
    agentSessionsStore.find(sessionHeader) !== undefined
      ? sessionHeader
      : null;
  auditStore.record({
    action: PERSONAL_TOKEN_WRITE,
    subjectType: "route",
    subjectId: PATH_ID_PATTERN.exec(url.pathname)?.[1] ?? null,
    actorUserId: userId,
    via: "mcp",
    agentSessionId: sessionId,
    detail: { method: request.method, path: url.pathname, status },
  });
  if (sessionId !== null) {
    agentSessionsStore.countWrite(sessionId);
  }
}
