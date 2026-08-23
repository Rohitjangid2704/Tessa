import { z } from "zod";
import { createSearchParamsCodec, enumParam, uuidParam } from "@/lib/search-params";
import { AUDIT_SUBJECT_TYPES, AUDIT_VIA_VALUES } from "./labels";

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

export function sinceDateParam() {
  return z.preprocess((raw) => {
    const value: unknown = Array.isArray(raw) ? raw[0] : undefined;
    if (typeof value !== "string" || !DATE_TEXT.test(value.trim())) {
      return undefined;
    }
    const date = value.trim();
    return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? undefined : date;
  }, z.string().optional());
}

export const auditFiltersCodec = createSearchParamsCodec({
  actor: uuidParam(),
  via: enumParam(AUDIT_VIA_VALUES),
  subject_type: enumParam(AUDIT_SUBJECT_TYPES),
  since: sinceDateParam(),
  session: uuidParam(),
});

export const auditFiltersSchema = auditFiltersCodec.schema;

export type AuditFilterValues = ReturnType<typeof auditFiltersCodec.parse>;

export interface AuditListFilters {
  actor_user_id?: string;
  via?: AuditFilterValues["via"];
  subject_type?: AuditFilterValues["subject_type"];
  since?: string;
  agent_session_id?: string;
}

export function sinceToTimestamp(date: string): string {
  return `${date}T00:00:00Z`;
}

export function toAuditListFilters(values: AuditFilterValues): AuditListFilters {
  return {
    actor_user_id: values.actor,
    via: values.via,
    subject_type: values.subject_type,
    since: values.since === undefined ? undefined : sinceToTimestamp(values.since),
    agent_session_id: values.session,
  };
}
