import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownStreamEvent } from "@/features/streams/events";
import { qk } from "@/lib/api/query-keys";
import type { UseEventStreamOptions } from "@/lib/sse/use-event-stream";
import { createTestQueryClient } from "@/tests/utils/render";
import {
  FIXTURE_AGENT_SESSION_ID,
  FIXTURE_TARGET_ID,
  FIXTURE_USER_ID,
} from "@/tests/utils/stream-fixtures";
import { AGENT_SESSIONS_THROTTLE_MS, useAgentSessionsFeed } from "./use-agent-sessions-feed";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const captured = vi.hoisted(() => ({ options: null as UseEventStreamOptions | null, path: "" }));

vi.mock("@/lib/sse/use-event-stream", () => ({
  useEventStream: (path: string | null, options: UseEventStreamOptions) => {
    captured.path = path ?? "";
    captured.options = options;
    return { status: "live" };
  },
}));

const TARGET_ID = FIXTURE_TARGET_ID;
const TS = "2026-10-09T10:00:00Z";

const SESSION_CHANGED: KnownStreamEvent = {
  type: "agent_session.changed",
  run_id: null,
  seq: null,
  ts: TS,
  payload: {
    agent_session_id: FIXTURE_AGENT_SESSION_ID,
    user_id: FIXTURE_USER_ID,
    target_id: TARGET_ID,
    active: true,
  },
};

const DASHBOARD_INVALIDATE: KnownStreamEvent = {
  type: "dashboard.invalidate",
  run_id: null,
  seq: null,
  ts: TS,
  payload: {},
};

function setup() {
  const queryClient = createTestQueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(() => useAgentSessionsFeed(TARGET_ID), { wrapper });
  return invalidate;
}

function fire(event: KnownStreamEvent): void {
  captured.options?.onEvent?.(event);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentSessionsFeed", () => {
  it("follows the home feed of its target", () => {
    setup();

    expect(captured.path).toBe("/api/v1/feeds/home");
    expect(captured.options?.query).toEqual({ target_id: TARGET_ID });
  });

  it("refreshes every agent session list once for a burst of changes", () => {
    const invalidate = setup();

    fire(SESSION_CHANGED);
    fire(SESSION_CHANGED);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AGENT_SESSIONS_THROTTLE_MS);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.agentSessions.all() });
  });

  it("ignores other home events", () => {
    const invalidate = setup();

    fire(DASHBOARD_INVALIDATE);
    vi.advanceTimersByTime(AGENT_SESSIONS_THROTTLE_MS * 2);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("refreshes after a reconnect but not on the first hello", () => {
    const invalidate = setup();
    const hello = DASHBOARD_INVALIDATE;

    captured.options?.onHello?.(hello, { reconnect: false });
    vi.advanceTimersByTime(AGENT_SESSIONS_THROTTLE_MS);
    expect(invalidate).not.toHaveBeenCalled();

    captured.options?.onHello?.(hello, { reconnect: true });
    vi.advanceTimersByTime(AGENT_SESSIONS_THROTTLE_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
