import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { AuditListFilters } from "./schemas";

export const AGENT_SESSIONS_PANEL_LIMIT = 5;
export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_ACTOR_LIMIT = 200;

export function agentSessionsQuery(targetId: string, limit = AGENT_SESSIONS_PANEL_LIMIT) {
  return queryOptions({
    queryKey: qk.agentSessions.forTarget(targetId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/agent-sessions", {
          params: { query: { target_id: targetId, limit, include_total: true } },
          signal,
        }),
      ),
    meta: INLINE_ERROR_META,
  });
}

export function auditEventsQuery(filters: AuditListFilters = {}, pageSize = AUDIT_PAGE_SIZE) {
  return cursorInfiniteOptions({
    queryKey: qk.auditEvents.list({ ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/audit-events", {
          params: { query: { ...filters, cursor, limit: pageSize, include_total: true } },
          signal,
        }),
      ),
  });
}

export function auditActorsQuery() {
  return queryOptions({
    queryKey: qk.users.list({ probe: "audit-actors", limit: AUDIT_ACTOR_LIMIT }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/users", {
          params: { query: { limit: AUDIT_ACTOR_LIMIT } },
          signal,
        }),
      ),
    select: (page) => page.items,
    meta: INLINE_ERROR_META,
  });
}
