import type { AuditAction, AuditEvent, AuditSubjectType, AuditVia } from "@/lib/api/types";
import { mockState } from "../state";
import { buildAuditEvent, seededEvents, type AuditVariant } from "./audit-data";

export interface AuditRecordInput {
  action: AuditAction;
  subjectType: AuditSubjectType;
  subjectId?: string | null;
  actorUserId?: string | null;
  via: AuditVia;
  agentSessionId?: string | null;
  detail?: Record<string, unknown>;
}

export class AuditStore {
  private events: AuditEvent[] = [];
  private variant: AuditVariant = "default";

  constructor() {
    this.load("default");
  }

  get currentVariant(): AuditVariant {
    return this.variant;
  }

  load(variant: AuditVariant): void {
    this.events = seededEvents(variant, Date.now());
    this.variant = variant;
  }

  all(): AuditEvent[] {
    return this.events.map((event) => ({ ...event, detail: { ...event.detail } }));
  }

  record(input: AuditRecordInput): AuditEvent {
    const event = buildAuditEvent(Date.now(), {
      action: input.action,
      subject_type: input.subjectType,
      subject_id: input.subjectId ?? null,
      actor_user_id: input.actorUserId ?? null,
      via: input.via,
      agent_session_id: input.agentSessionId ?? null,
      detail: { ...(input.detail ?? {}) },
    });
    this.events.push(event);
    return event;
  }

  count(): number {
    return this.events.length;
  }

  reset(): void {
    this.load("default");
  }
}

export const auditStore = new AuditStore();

mockState.stageTwo.onReset(() => auditStore.reset());
