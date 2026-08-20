export const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
export const MAX_BACKOFF_MS = 30_000;
export const BACKOFF_JITTER_RATIO = 0.2;
export const SILENCE_TIMEOUT_MS = 45_000;

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 1), BACKOFF_SCHEDULE_MS.length) - 1;
  const base = BACKOFF_SCHEDULE_MS[index] ?? MAX_BACKOFF_MS;
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER_RATIO;
  return Math.min(Math.round(base * jitter), MAX_BACKOFF_MS);
}
