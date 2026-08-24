import type { KnownStreamEvent, PayloadOfEvent } from "@/features/streams/events";
import type { BrowserSession, Viewport } from "@/lib/api/types";
import type { SnapshotSource } from "./frame-throttled-source";
import type { RunEventFeed } from "./run-event-store";

export type SessionStartedPayload = PayloadOfEvent<"browser_session.started">;

export type SessionEndedPayload = PayloadOfEvent<"browser_session.ended">;

export interface SessionEvents {
  started: readonly SessionStartedPayload[];
  ended: readonly SessionEndedPayload[];
}

export interface TileSession {
  id: string;
  runScenarioId: string;
  attempt: number;
  title: string;
  viewport: Viewport;
  startedAt: string;
  endedAt: string | null;
  lastUrl: string | null;
  hasRecording: boolean;
  hasTrace: boolean;
}

export const EMPTY_SESSION_EVENTS: SessionEvents = { started: [], ended: [] };

export function deriveSessionEvents(events: readonly KnownStreamEvent[]): SessionEvents {
  const started: SessionStartedPayload[] = [];
  const ended: SessionEndedPayload[] = [];
  for (const event of events) {
    if (event.type === "browser_session.started") {
      started.push(event.payload);
    } else if (event.type === "browser_session.ended") {
      ended.push(event.payload);
    }
  }
  return { started, ended };
}

function sameItems<Item>(left: readonly Item[], right: readonly Item[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function sameSessionEvents(left: SessionEvents, right: SessionEvents): boolean {
  return sameItems(left.started, right.started) && sameItems(left.ended, right.ended);
}

export function createSessionEventsSource(feed: RunEventFeed): SnapshotSource<SessionEvents> {
  let lastEvents: readonly KnownStreamEvent[] | null = null;
  let lastResult: SessionEvents = EMPTY_SESSION_EVENTS;
  return {
    subscribe: feed.subscribe,
    getSnapshot: () => {
      const { events } = feed.getSnapshot();
      if (events === lastEvents) {
        return lastResult;
      }
      lastEvents = events;
      const next = deriveSessionEvents(events);
      if (!sameSessionEvents(lastResult, next)) {
        lastResult = next;
      }
      return lastResult;
    },
  };
}

function fromRest(session: BrowserSession): TileSession {
  return {
    id: session.id,
    runScenarioId: session.run_scenario_id,
    attempt: session.attempt,
    title: session.scenario_title,
    viewport: session.viewport,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    lastUrl: session.last_url,
    hasRecording: session.has_recording,
    hasTrace: session.has_trace,
  };
}

function fromStartedEvent(payload: SessionStartedPayload): TileSession {
  return {
    id: payload.browser_session_id,
    runScenarioId: payload.run_scenario_id,
    attempt: payload.attempt,
    title: payload.scenario_title,
    viewport: payload.viewport,
    startedAt: payload.started_at,
    endedAt: null,
    lastUrl: null,
    hasRecording: false,
    hasTrace: false,
  };
}

export function mergeTileSessions(
  rest: readonly BrowserSession[],
  events: SessionEvents,
): TileSession[] {
  const byId = new Map<string, TileSession>();
  for (const session of rest) {
    byId.set(session.id, fromRest(session));
  }
  for (const payload of events.started) {
    if (!byId.has(payload.browser_session_id)) {
      byId.set(payload.browser_session_id, fromStartedEvent(payload));
    }
  }
  for (const payload of events.ended) {
    const existing = byId.get(payload.browser_session_id);
    if (existing !== undefined && existing.endedAt === null) {
      byId.set(payload.browser_session_id, {
        ...existing,
        endedAt: payload.ended_at,
        hasRecording: payload.has_recording,
        hasTrace: payload.has_trace,
      });
    }
  }
  return [...byId.values()];
}

export function isSessionEnded(session: TileSession, runEnded: boolean): boolean {
  return runEnded || session.endedAt !== null;
}

function timeOf(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byStartedAt(left: TileSession, right: TileSession): number {
  return timeOf(left.startedAt) - timeOf(right.startedAt) || left.id.localeCompare(right.id, "en");
}

function byEndedAtNewestFirst(left: TileSession, right: TileSession): number {
  return timeOf(right.endedAt) - timeOf(left.endedAt) || byStartedAt(left, right);
}

export function orderTileSessions(
  sessions: readonly TileSession[],
  runEnded: boolean,
): TileSession[] {
  const active = sessions.filter((session) => !isSessionEnded(session, runEnded));
  const finished = sessions.filter((session) => isSessionEnded(session, runEnded));
  return [
    ...active.sort(byStartedAt),
    ...finished.sort(runEnded ? byStartedAt : byEndedAtNewestFirst),
  ];
}

export interface TilePreviewSize {
  width: number;
  height: number;
}

export function previewSize(viewport: Viewport, maxWidth: number): TilePreviewSize {
  const width = Math.min(viewport.width, maxWidth);
  return { width, height: Math.max(1, Math.round((width * viewport.height) / viewport.width)) };
}
