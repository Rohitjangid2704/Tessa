import type { AuditEvent, AuditVia } from "@/lib/api/types";
import type { PageSpec, QueryReader } from "../factories/pagination";
import { validationFailed } from "../factories/errors";
import { AUDIT_VIA_VALUES } from "./audit-data";

export const AUDIT_PAGE: PageSpec<AuditEvent> = {
  sortKeys: {
    created_at: { kind: "timestamp", value: (event) => event.created_at },
  },
  defaultSort: "-created_at",
  getId: (event) => event.id,
};

export interface AuditFilters {
  actorUserId: string | undefined;
  via: AuditVia | undefined;
  subjectType: string | undefined;
  subjectId: string | undefined;
  agentSessionId: string | undefined;
  sinceMs: number | undefined;
}

const SUBJECT_MAX = 100;

export function readAuditFilters(query: QueryReader): AuditFilters {
  const actorUserId = query.uuid("actor_user_id");
  const via = query.enumList("via", AUDIT_VIA_VALUES)?.[0];
  const subjectType = query.text("subject_type", { max: SUBJECT_MAX });
  const subjectId = query.text("subject_id", { max: SUBJECT_MAX });
  const agentSessionId = query.uuid("agent_session_id");
  const since = query.text("since", { max: SUBJECT_MAX });
  let sinceMs: number | undefined;
  if (since !== undefined) {
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) {
      throw validationFailed([
        {
          loc: ["query", "since"],
          code: "datetime_from_date_parsing",
          message: "Input should be a valid datetime",
        },
      ]);
    }
    sinceMs = parsed;
  }
  return { actorUserId, via, subjectType, subjectId, agentSessionId, sinceMs };
}

export function matchesAuditFilters(event: AuditEvent, filters: AuditFilters): boolean {
  return (
    (filters.actorUserId === undefined || event.actor_user_id === filters.actorUserId) &&
    (filters.via === undefined || event.via === filters.via) &&
    (filters.subjectType === undefined || event.subject_type === filters.subjectType) &&
    (filters.subjectId === undefined || event.subject_id === filters.subjectId) &&
    (filters.agentSessionId === undefined || event.agent_session_id === filters.agentSessionId) &&
    (filters.sinceMs === undefined || Date.parse(event.created_at) >= filters.sinceMs)
  );
}
