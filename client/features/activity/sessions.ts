import type { AgentSession } from "@/lib/api/types";

export type AgentSessionState = "active" | "ended" | "inactive";

export const SESSION_SUMMARY_PREVIEW_CHARS = 140;

export function agentSessionState(
  session: Pick<AgentSession, "ended_at" | "active">,
): AgentSessionState {
  if (session.ended_at !== null) {
    return "ended";
  }
  return session.active ? "active" : "inactive";
}

export function summaryNeedsExpander(summary: string | null): boolean {
  return summary !== null && summary.length > SESSION_SUMMARY_PREVIEW_CHARS;
}

export function pluralizeWrites(count: number): string {
  return count === 1 ? "1 write" : `${count} writes`;
}
