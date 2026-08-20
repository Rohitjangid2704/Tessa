import { isApiError } from "./errors";
import type { OracleResultStatus, RunStatus } from "./types";

export const RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "canceled",
  "budget_exceeded",
] as const satisfies readonly RunStatus[];

export const ORACLE_SETTLED_STATUSES = [
  "ok",
  "error",
] as const satisfies readonly OracleResultStatus[];

const RESTART_AFTER_SLOW_INTERVALS = 3;

export interface PollingProfile {
  fastMs: number;
  fastWindowMs: number;
  slowMs: number;
  isSettled: (data: unknown) => boolean;
}

export interface PollableQuery {
  state: { data: unknown; error: unknown };
}

export type RefetchInterval = (query: PollableQuery) => number | false;

function statusOf(data: unknown): unknown {
  return typeof data === "object" && data !== null && "status" in data ? data.status : undefined;
}

function hasStatusIn(data: unknown, statuses: readonly string[]): boolean {
  const status = statusOf(data);
  return typeof status === "string" && statuses.includes(status);
}

export function isRunTerminal(data: unknown): boolean {
  return hasStatusIn(data, RUN_TERMINAL_STATUSES);
}

export function isOracleSettled(data: unknown): boolean {
  return hasStatusIn(data, ORACLE_SETTLED_STATUSES);
}

export const RUN_POLLING_PROFILE: PollingProfile = {
  fastMs: 1000,
  fastWindowMs: 30_000,
  slowMs: 5000,
  isSettled: isRunTerminal,
};

export const ORACLE_POLLING_PROFILE: PollingProfile = {
  fastMs: 500,
  fastWindowMs: 10_000,
  slowMs: 2000,
  isSettled: isOracleSettled,
};

interface PollingClock {
  startedAt: number;
  lastEvaluatedAt: number;
}

export function createRefetchInterval(
  profile: PollingProfile,
  now: () => number = () => Date.now(),
): RefetchInterval {
  const clocks = new WeakMap<object, PollingClock>();
  const restartAfterMs = profile.slowMs * RESTART_AFTER_SLOW_INTERVALS;

  return (query) => {
    const { data, error } = query.state;
    if (profile.isSettled(data)) {
      clocks.delete(query);
      return false;
    }
    if (isApiError(error) && error.isClientError) {
      return false;
    }
    const current = now();
    const previous = clocks.get(query);
    const startedAt =
      previous === undefined || current - previous.lastEvaluatedAt > restartAfterMs
        ? current
        : previous.startedAt;
    clocks.set(query, { startedAt, lastEvaluatedAt: current });
    return current - startedAt < profile.fastWindowMs ? profile.fastMs : profile.slowMs;
  };
}

export const runRefetchInterval = createRefetchInterval(RUN_POLLING_PROFILE);

export const oracleRefetchInterval = createRefetchInterval(ORACLE_POLLING_PROFILE);

export const NOTIFICATION_POLL_INTERVAL_MS = 60_000;

export const polling = {
  run: { refetchInterval: runRefetchInterval, refetchIntervalInBackground: false },
  oracle: { refetchInterval: oracleRefetchInterval, refetchIntervalInBackground: false },
  notifications: {
    refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  },
} as const;
