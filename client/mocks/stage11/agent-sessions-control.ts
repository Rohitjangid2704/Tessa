import { z } from "zod";
import { notFound } from "../factories/errors";
import { MEMBER_USER } from "../factories/users";
import { STAGE_ONE_IDS } from "../stage1/seed";
import { AGENT_SESSION_SUMMARY_MAX, buildAgentSession } from "./agent-sessions-data";
import { agentSessionsStore } from "./agent-sessions-store";

const HOUR_MS = 3_600_000;

export const agentSessionControlSchema = z.strictObject({
  session_id: z.guid().optional(),
  user_id: z.guid().optional(),
  target_id: z.guid().nullable().optional(),
  cwd_label: z.string().min(1).max(120).optional(),
  summary: z.string().max(AGENT_SESSION_SUMMARY_MAX).nullable().optional(),
  ended: z.boolean().optional(),
  started_hours_ago: z.number().min(0).max(720).optional(),
});

export type AgentSessionControlInput = z.infer<typeof agentSessionControlSchema>;

export function fireAgentSessionChange(input: AgentSessionControlInput) {
  if (input.session_id === undefined) {
    const startedAt = Date.now() - (input.started_hours_ago ?? 0) * HOUR_MS;
    const created = buildAgentSession(startedAt, {
      user_id: input.user_id ?? MEMBER_USER.id,
      target_id: input.target_id === undefined ? STAGE_ONE_IDS.gracie : input.target_id,
      ...(input.cwd_label === undefined ? {} : { cwd_label: input.cwd_label }),
      summary: input.summary ?? null,
      ended_at: input.ended === true ? new Date().toISOString() : null,
    });
    agentSessionsStore.add(created);
    agentSessionsStore.announce(created);
    return created;
  }
  const session = agentSessionsStore.find(input.session_id);
  if (session === undefined) {
    throw notFound("Agent session not found");
  }
  if (input.target_id !== undefined) {
    session.target_id = input.target_id;
  }
  if (input.summary !== undefined) {
    session.summary = input.summary;
  }
  if (input.ended === true && session.ended_at === null) {
    session.ended_at = new Date().toISOString();
  }
  const refreshed = agentSessionsStore.find(session.id) ?? session;
  agentSessionsStore.announce(refreshed);
  return { ...refreshed };
}
