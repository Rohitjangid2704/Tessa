import { describe, expect, it, vi } from "vitest";
import { canDo } from "./can";
import type { UserRole } from "./schemas";
import {
  PERMISSIONS,
  PERMISSION_IDS,
  isPermissionId,
  permissionsRequiring,
  requiredRoleFor,
  type PermissionId,
} from "./permissions";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const STAGE_ELEVEN_MATRIX: ReadonlyArray<readonly [PermissionId, "viewer" | "member" | "admin"]> = [
  ["tokens.manage_own", "viewer"],
  ["agent_sessions.read", "viewer"],
  ["audit.read", "admin"],
  ["proposals.select", "member"],
  ["proposals.put", "member"],
];

const STAGE_ELEVEN_BY_ROLE: Record<UserRole, readonly PermissionId[]> = {
  viewer: ["tokens.manage_own", "agent_sessions.read"],
  member: ["tokens.manage_own", "agent_sessions.read", "proposals.select", "proposals.put"],
  admin: [
    "tokens.manage_own",
    "agent_sessions.read",
    "audit.read",
    "proposals.select",
    "proposals.put",
  ],
};

describe("permission matrix", () => {
  it.each(Object.entries(STAGE_ELEVEN_BY_ROLE) as Array<[UserRole, readonly PermissionId[]]>)(
    "a %s may do exactly these Stage 11 actions",
    (role, allowed) => {
      for (const [action] of STAGE_ELEVEN_MATRIX) {
        expect(canDo(role, action)).toBe(allowed.includes(action));
      }
    },
  );

  it("covers every permission added by Stage 11", () => {
    const stageEleven = PERMISSION_IDS.filter((id) =>
      /^(tokens|agent_sessions|audit|proposals)\./.test(id),
    );
    expect([...stageEleven].sort()).toEqual(STAGE_ELEVEN_MATRIX.map(([id]) => id).sort());
  });

  it.each(STAGE_ELEVEN_MATRIX)("%s requires %s", (action, role) => {
    expect(isPermissionId(action)).toBe(true);
    expect(requiredRoleFor(action)).toBe(role);
    expect(permissionsRequiring(role)).toContain(action);
  });

  it("lists every permission under exactly one role", () => {
    const grouped = [
      ...permissionsRequiring("viewer"),
      ...permissionsRequiring("member"),
      ...permissionsRequiring("admin"),
    ];
    expect([...grouped].sort()).toEqual([...PERMISSION_IDS].sort());
    expect(new Set(grouped).size).toBe(Object.keys(PERMISSIONS).length);
  });

  it("rejects an unknown permission id", () => {
    expect(isPermissionId("tokens.manage_all")).toBe(false);
  });
});
