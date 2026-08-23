import type { FindingStatus } from "@/lib/api/types";
import { isLocalUpdatePending } from "./detail-mutations";

const ECHO_WINDOW_MS = 15_000;

const inFlight = new Set<string>();
const settled = new Map<string, { status: FindingStatus; atMs: number }>();

export function beginLocalMove(findingId: string): void {
  inFlight.add(findingId);
}

export function endLocalMove(findingId: string, status: FindingStatus | null, atMs: number): void {
  inFlight.delete(findingId);
  if (status === null) {
    settled.delete(findingId);
    return;
  }
  settled.set(findingId, { status, atMs });
}

export function isLocalMove(findingId: string, status: FindingStatus, nowMs: number): boolean {
  if (inFlight.has(findingId) || isLocalUpdatePending(findingId)) {
    return true;
  }
  const echo = settled.get(findingId);
  if (echo === undefined) {
    return false;
  }
  if (nowMs - echo.atMs > ECHO_WINDOW_MS) {
    settled.delete(findingId);
    return false;
  }
  return echo.status === status;
}
