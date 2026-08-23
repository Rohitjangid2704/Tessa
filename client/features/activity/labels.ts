import type { AuditAction, AuditSubjectType, AuditVia } from "@/lib/api/types";

export const AUDIT_VIA_VALUES = ["web", "mcp", "svc"] as const satisfies readonly AuditVia[];

export const AUDIT_VIA_LABELS: Record<AuditVia, string> = {
  web: "Web",
  mcp: "Claude Code",
  svc: "Service key",
};

export const AUDIT_SUBJECT_TYPES = [
  "user",
  "team",
  "target",
  "secret",
  "retention",
  "personal_token",
  "route",
  "proposal",
] as const satisfies readonly AuditSubjectType[];

export const AUDIT_SUBJECT_LABELS: Record<AuditSubjectType, string> = {
  user: "User",
  team: "Team",
  target: "Target",
  secret: "Secret",
  retention: "Retention",
  personal_token: "Personal token",
  route: "API route",
  proposal: "Proposal",
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  user_created: "User created",
  user_role_changed: "User role changed",
  user_active_changed: "User activation changed",
  sso_user_provisioned: "SSO user provisioned",
  team_created: "Team created",
  team_renamed: "Team renamed",
  team_members_changed: "Team members changed",
  team_budget_set: "Team budget set",
  target_team_changed: "Target team changed",
  retention_policy_changed: "Retention policy changed",
  secret_set: "Secret set",
  secret_deleted: "Secret deleted",
  allow_production_changed: "Production access changed",
  allow_jev_changed: "Jev access changed",
  token_created: "Token created",
  token_revoked: "Token revoked",
  personal_token_write: "Write with a personal token",
  proposal_put: "Proposal replaced",
  proposal_item_changed: "Proposal item changed",
};

export function auditActionLabel(action: AuditAction): string {
  return AUDIT_ACTION_LABELS[action];
}

export function auditSubjectLabel(subject: AuditSubjectType): string {
  return AUDIT_SUBJECT_LABELS[subject];
}
