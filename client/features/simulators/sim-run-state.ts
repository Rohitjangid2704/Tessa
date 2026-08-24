import type { KnownStreamEvent } from "@/features/streams/events";
import type { SimChecks, SimSpeaker, Verdict } from "./types";

export interface LiveTurn {
  key: string;
  turn: number;
  speaker: SimSpeaker;
  preview: string;
}

export interface LiveChecked {
  checks: SimChecks;
  verdict: Verdict;
}

export interface LiveAttempt {
  sessionId: string;
  attempt: number;
  turns: LiveTurn[];
  checked: LiveChecked | null;
}

export function deriveAttempts(events: readonly KnownStreamEvent[]): LiveAttempt[] {
  const attempts = new Map<string, LiveAttempt>();

  function attemptOf(sessionId: string): LiveAttempt {
    const existing = attempts.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: LiveAttempt = { sessionId, attempt: attempts.size, turns: [], checked: null };
    attempts.set(sessionId, created);
    return created;
  }

  for (const event of events) {
    if (event.type === "sim.turn") {
      const { sim_session_id: sessionId, turn, speaker, text_preview: preview } = event.payload;
      const attempt = attemptOf(sessionId);
      if (!attempt.turns.some((existing) => existing.turn === turn)) {
        attempt.turns.push({ key: `${sessionId}-${turn}`, turn, speaker, preview });
      }
    } else if (event.type === "sim.checked") {
      const { sim_session_id: sessionId, checks, verdict } = event.payload;
      attemptOf(sessionId).checked = { checks, verdict };
    }
  }

  return [...attempts.values()].map((attempt) => ({
    ...attempt,
    turns: [...attempt.turns].sort((left, right) => left.turn - right.turn),
  }));
}

export type AttemptPhase = "talking" | "checked" | "stopped";

export function phaseOf(attempt: LiveAttempt, runEnded: boolean): AttemptPhase {
  if (attempt.checked !== null) {
    return "checked";
  }
  return runEnded ? "stopped" : "talking";
}
