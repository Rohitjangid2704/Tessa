import type { AuditAction, AuditEvent, AuditSubjectType, AuditVia } from "@/lib/api/types";
import { newId } from "../factories/ids";
import { SEEDED_AGENT_SESSION_ID } from "./agent-sessions-data";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "../factories/users";

export const AUDIT_VARIANTS = ["default", "empty", "many"] as const;

export type AuditVariant = (typeof AUDIT_VARIANTS)[number];

export const AUDIT_VIA_VALUES = ["web", "mcp", "svc"] as const satisfies readonly AuditVia[];

export const PERSONAL_TOKEN_SUBJECT = "personal_token" satisfies AuditSubjectType;
export const PERSONAL_TOKEN_WRITE = "personal_token_write" satisfies AuditAction;
export const TOKEN_CREATED = "token_created" satisfies AuditAction;
export const TOKEN_REVOKED = "token_revoked" satisfies AuditAction;

export const AUDIT_PAGE_SEARCH_MAX = 200;
export const MANY_AUDIT_ROWS = 2000;

const HOUR_MS = 3_600_000;
const SEEDED_ACTIONS = [
  { action: TOKEN_CREATED, subject: PERSONAL_TOKEN_SUBJECT, via: "web" },
  { action: PERSONAL_TOKEN_WRITE, subject: "route", via: "mcp" },
  { action: PERSONAL_TOKEN_WRITE, subject: "route", via: "mcp" },
  { action: "user_role_changed", subject: "user", via: "web" },
  { action: TOKEN_REVOKED, subject: PERSONAL_TOKEN_SUBJECT, via: "web" },
  { action: "secret_set", subject: "secret", via: "web" },
] as const satisfies ReadonlyArray<{
  action: AuditAction;
  subject: AuditSubjectType;
  via: AuditVia;
}>;

const SEEDED_ACTORS = [ADMIN_USER.id, MEMBER_USER.id, VIEWER_USER.id];

export function buildAuditEvent(
  now: number,
  overrides: Partial<AuditEvent> & Pick<AuditEvent, "action" | "subject_type" | "via">,
): AuditEvent {
  return {
    id: newId(now),
    actor_user_id: ADMIN_USER.id,
    agent_session_id: null,
    created_at: new Date(now).toISOString(),
    detail: {},
    subject_id: null,
    ...overrides,
  };
}

export function seededEvents(variant: AuditVariant, now: number): AuditEvent[] {
  if (variant === "empty") {
    return [];
  }
  const count = variant === "many" ? MANY_AUDIT_ROWS : SEEDED_ACTIONS.length * 2;
  return Array.from({ length: count }, (_, index) => {
    const template = SEEDED_ACTIONS[index % SEEDED_ACTIONS.length] ?? SEEDED_ACTIONS[0];
    return buildAuditEvent(now - (index + 1) * HOUR_MS, {
      action: template.action,
      subject_type: template.subject,
      via: template.via,
      actor_user_id: SEEDED_ACTORS[index % SEEDED_ACTORS.length] ?? ADMIN_USER.id,
      subject_id: newId(now - index),
      agent_session_id: template.via === "mcp" && index < 8 ? SEEDED_AGENT_SESSION_ID : null,
      detail:
        template.via === "mcp"
          ? { method: "POST", path: "/api/v1/bundles", status: 201, request_id: `req-${index}` }
          : {},
    });
  });
}
