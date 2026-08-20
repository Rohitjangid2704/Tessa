import type { UserRole } from "./schemas";

export const PERMISSIONS = {
  "system.hello_run": "member",

  "targets.create": "member",
  "targets.create_production": "admin",
  "targets.update": "member",
  "targets.allow_production": "admin",
  "targets.archive": "admin",
  "targets.rotate_token": "member",
  "targets.set_team": "admin",

  "prompts.issue": "member",

  "bundles.upload": "member",
  "bundles.source_write": "member",
  "bundles.source_pull": "member",

  "environment.write": "member",
  "environment.health_check": "member",

  "plans.save": "member",
  "plans.delete": "member",

  "runs.start": "member",
  "runs.start_group": "member",
  "runs.cancel": "member",
  "runs.stop": "member",

  "scenarios.create": "member",
  "scenarios.edit": "member",
  "scenarios.set_status": "member",
  "scenarios.review": "member",

  "coverage.generate": "member",

  "seeds.verify": "member",
  "seeds.reset": "member",

  "oracle.run": "member",
  "oracle.approve": "member",

  "labels.create": "member",
  "labels.delete": "member",
  "labels.export": "admin",
  "calibration.fit": "admin",

  "findings.update": "member",
  "findings.explain": "member",
  "findings.promote": "member",

  "explore.start": "member",
  "simulators.start": "member",
  "personas.write": "member",
  "goals.write": "member",
  "redteam.start": "member",
  "replay.upload": "member",

  "mutants.write": "member",
  "mutation.run": "member",

  "schedules.write": "member",
  "schedules.run_now": "member",

  "contracts.check": "member",

  "settings.write": "admin",
  "settings.secrets": "admin",
  "settings.test_service": "admin",

  "users.manage": "admin",
  "teams.manage": "admin",
  "retention.write": "admin",
  "jev.consent": "admin",

  "tokens.manage_own": "viewer",
  "agent_sessions.read": "viewer",
  "audit.read": "admin",
  "proposals.select": "member",
  "proposals.put": "member",
} as const satisfies Record<string, UserRole>;

export type PermissionMap = typeof PERMISSIONS;

export type PermissionId = keyof PermissionMap;

export const PERMISSION_IDS: readonly PermissionId[] = Object.keys(PERMISSIONS) as PermissionId[];

export function isPermissionId(value: string): value is PermissionId {
  return (PERMISSION_IDS as readonly string[]).includes(value);
}

export function requiredRoleFor(action: PermissionId): UserRole {
  return PERMISSIONS[action];
}

export function requirementText(role: UserRole): string {
  return `Requires ${role}`;
}

export function permissionsRequiring(role: UserRole): readonly PermissionId[] {
  return PERMISSION_IDS.filter((action) => PERMISSIONS[action] === role);
}
