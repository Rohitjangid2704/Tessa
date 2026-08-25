import type { AgentSession } from "@/lib/api/types";
import { stageEight } from "../stage8/store";
import { mockState } from "../state";
import { refreshActive, seededSessions, type AgentSessionsVariant } from "./agent-sessions-data";

export const AGENT_SESSION_CHANGED = "agent_session.changed";

export class AgentSessionsStore {
  private sessions: AgentSession[] = [];
  private variant: AgentSessionsVariant = "default";

  constructor() {
    this.load("default");
  }

  get currentVariant(): AgentSessionsVariant {
    return this.variant;
  }

  load(variant: AgentSessionsVariant): void {
    this.sessions = seededSessions(variant, Date.now());
    this.variant = variant;
  }

  all(): AgentSession[] {
    return this.sessions.map((session) => ({ ...refreshActive(session) }));
  }

  find(sessionId: string): AgentSession | undefined {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    return session === undefined ? undefined : refreshActive(session);
  }

  add(session: AgentSession): void {
    this.sessions.push(session);
  }

  countWrite(sessionId: string): void {
    const session = this.find(sessionId);
    if (session !== undefined) {
      session.write_count += 1;
    }
  }

  announce(session: AgentSession): void {
    stageEight.bus.publish(AGENT_SESSION_CHANGED, {
      target_id: session.target_id,
      agent_session_id: session.id,
      user_id: session.user_id,
      active: refreshActive(session).active,
    });
  }

  count(): number {
    return this.sessions.length;
  }

  reset(): void {
    this.load("default");
  }
}

export const agentSessionsStore = new AgentSessionsStore();

mockState.stageTwo.onReset(() => agentSessionsStore.reset());
