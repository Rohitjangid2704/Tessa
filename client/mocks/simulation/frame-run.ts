import { newId } from "../factories/ids";
import { createFrameSessions, DEFAULT_FRAME_SESSIONS, getFramePool } from "../server/frames";
import type { FrameSession } from "../server/frames";
import type { MockState, RunRecord } from "../state";
import type { MockUser } from "../types";

export const MAX_FRAME_SESSIONS = 24;

const VIEWPORT = { width: 1280, height: 800 };
const FRAME_RUN_ATTEMPT = 0;

export async function startFrameRun(
  state: MockState,
  user: MockUser,
  requestedSessions: number = DEFAULT_FRAME_SESSIONS,
): Promise<{ run: RunRecord; sessions: FrameSession[] }> {
  const sessionCount = Math.min(MAX_FRAME_SESSIONS, Math.max(1, Math.trunc(requestedSessions)));
  const sessions = createFrameSessions(sessionCount);
  await getFramePool(sessionCount);

  const run: RunRecord = {
    id: newId(),
    createdBy: user.id,
    events: [],
    finished: false,
    timers: [],
    frameSessions: sessions,
  };
  state.runs.set(run.id, run);

  state.appendEvent(run, "run.created", {
    kind: "suite",
    target_id: null,
    plan_id: null,
    trigger: "manual",
    created_by: user.id,
    status: "queued",
  });
  state.appendEvent(run, "run.status_changed", {
    status: "running",
    previous: "queued",
    reason: null,
  });
  for (const session of sessions) {
    state.appendRawEvent(run, "browser_session.started", {
      browser_session_id: session.id,
      run_scenario_id: newId(),
      attempt: FRAME_RUN_ATTEMPT,
      viewport: VIEWPORT,
      scenario_title: session.title,
      started_at: new Date().toISOString(),
    });
  }
  return { run, sessions };
}
