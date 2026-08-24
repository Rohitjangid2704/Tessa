import type { TrendPoint } from "@/lib/api/types";

export interface TrendDatum {
  time: number;
  value: number;
  runId: string | null;
  ts: string;
}

export function toTrendData(points: readonly TrendPoint[]): TrendDatum[] {
  return points
    .map((point) => ({
      time: Date.parse(point.ts),
      value: point.value,
      runId: point.run_id,
      ts: point.ts,
    }))
    .filter((datum) => Number.isFinite(datum.time) && Number.isFinite(datum.value))
    .sort((left, right) => left.time - right.time);
}

export function isTrendDatum(value: unknown): value is TrendDatum {
  return (
    typeof value === "object" &&
    value !== null &&
    "time" in value &&
    "value" in value &&
    "runId" in value
  );
}
