import type { AgentSession } from "@/lib/api/types";
import { newId } from "../factories/ids";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "../factories/users";
import { STAGE_ONE_IDS } from "../stage1/seed";

export const AGENT_SESSION_VARIANTS = ["default", "none", "many"] as const;

export type AgentSessionsVariant = (typeof AGENT_SESSION_VARIANTS)[number];

export const AGENT_SESSION_SUMMARY_MAX = 2000;
export const AGENT_SESSION_LABEL_MAX = 120;
export const MANY_AGENT_SESSIONS = 40;
export const SEEDED_AGENT_SESSION_ID = "0198f6f2-aaaa-7bbb-8ccc-000000000011";

const HOUR_MS = 3_600_000;

export function buildAgentSession(
  now: number,
  overrides: Partial<AgentSession> & Pick<AgentSession, "user_id">,
): AgentSession {
  const session: AgentSession = {
    id: newId(now),
    target_id: null,
    claude_session_id: crypto.randomUUID(),
    cwd_label: "gracie",
    plugin_version: "0.1.0",
    started_at: new Date(now).toISOString(),
    ended_at: null,
    summary: null,
    write_count: 0,
    user_name: userNameOf(overrides.user_id),
    active: true,
    ...overrides,
  };
  return refreshActive(session, now);
}

export const STALE_SESSION_MS = 12 * HOUR_MS;

export function refreshActive(session: AgentSession, now: number = Date.now()): AgentSession {
  session.active =
    session.ended_at === null && now - Date.parse(session.started_at) < STALE_SESSION_MS;
  return session;
}

export function userNameOf(userId: string): string {
  return [ADMIN_USER, MEMBER_USER, VIEWER_USER].find((user) => user.id === userId)?.name ?? "User";
}

export function seededSessions(variant: AgentSessionsVariant, now: number): AgentSession[] {
  if (variant === "none") {
    return [];
  }
  if (variant === "many") {
    return Array.from({ length: MANY_AGENT_SESSIONS }, (_, index) =>
      buildAgentSession(now - (index + 1) * HOUR_MS, {
        ...(index === 0 ? { id: SEEDED_AGENT_SESSION_ID } : {}),
        user_id: index % 2 === 0 ? ADMIN_USER.id : MEMBER_USER.id,
        target_id: STAGE_ONE_IDS.gracie,
        ended_at: index === 0 ? null : new Date(now - index * HOUR_MS + HOUR_MS / 2).toISOString(),
        summary: index === 0 ? null : `Session ${index}: explained a finding and re-ran a scenario`,
        write_count: index % 7,
      }),
    );
  }
  return [
    buildAgentSession(now - HOUR_MS / 4, {
      id: SEEDED_AGENT_SESSION_ID,
      user_id: MEMBER_USER.id,
      target_id: STAGE_ONE_IDS.gracie,
      write_count: 3,
    }),
    buildAgentSession(now - 6 * HOUR_MS, {
      user_id: ADMIN_USER.id,
      target_id: STAGE_ONE_IDS.gracie,
      cwd_label: "gracie-backend",
      ended_at: new Date(now - 5 * HOUR_MS).toISOString(),
      summary: "Discovered the bundle, filled the environment and explained two findings.",
      write_count: 9,
    }),
  ];
}
