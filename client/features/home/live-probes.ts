import { parseTimestamp } from "@/components/date-time";
import type { LiveProbeStat, LiveProbes } from "@/lib/api/types";
import type { KpiTone } from "./mutation-headline";

export const LIVE_PROBES_STALE_AFTER_MINUTES = 30;

const MS_PER_MINUTE = 60_000;

export const LIVE_PROBES_STALE_AFTER_MS = LIVE_PROBES_STALE_AFTER_MINUTES * MS_PER_MINUTE;

export type ProbeRateState = "rated" | "no_answers" | "ungraded";

export interface LiveProbesTone {
  tone: KpiTone;
  statusLabel: string | undefined;
}

export function probeRateState(stat: LiveProbeStat): ProbeRateState {
  if (stat.pass_rate !== null || stat.uncertain_rate !== null) {
    return "rated";
  }
  return stat.n === 0 ? "no_answers" : "ungraded";
}

export function ungradedProbeIds(data: LiveProbes): string[] {
  return data.by_probe
    .filter((stat) => probeRateState(stat) === "ungraded")
    .map((stat) => stat.probe_id);
}

export function isTrafficStale(lastIngestedAt: string | null, nowMs: number | null): boolean {
  const parsed = parseTimestamp(lastIngestedAt);
  if (parsed === null || nowMs === null) {
    return false;
  }
  return nowMs - parsed.getTime() > LIVE_PROBES_STALE_AFTER_MS;
}

export function describeWindow(hours: number): string {
  return hours === 1 ? "the last hour" : `the last ${hours} hours`;
}

export function liveProbesTone(
  data: LiveProbes | null | undefined,
  stale: boolean,
): LiveProbesTone {
  if (stale) {
    return { tone: "warn", statusLabel: "Stale" };
  }
  if (data !== null && data !== undefined && ungradedProbeIds(data).length > 0) {
    return { tone: "warn", statusLabel: "Probe issue" };
  }
  return { tone: "neutral", statusLabel: undefined };
}
