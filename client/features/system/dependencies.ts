import type { components } from "@/lib/api/schema";

export type DependencyHealth = components["schemas"]["DependencyHealth"];
export type DependencyCheck = components["schemas"]["DependencyCheck"];
export type DependencyStatus = components["schemas"]["DependencyStatus"];
export type DependencyKey = keyof DependencyHealth;

export const DEPENDENCY_KEYS = [
  "db",
  "temporal",
  "laya",
  "storage",
] as const satisfies readonly DependencyKey[];

export const DEPENDENCY_LABELS = {
  db: "Database",
  temporal: "Temporal",
  laya: "Laya",
  storage: "Storage",
} as const satisfies Record<DependencyKey, string>;

export type DependencyRow = {
  key: DependencyKey;
  label: string;
  status: DependencyStatus;
  latencyMs: number | null;
  detail: string | null;
};

export function toDependencyRows(health: DependencyHealth): DependencyRow[] {
  return DEPENDENCY_KEYS.map((key) => ({
    key,
    label: DEPENDENCY_LABELS[key],
    status: health[key].status,
    latencyMs: health[key].latency_ms,
    detail: health[key].detail,
  }));
}

export function downDependencyLabels(rows: readonly DependencyRow[]): string[] {
  return rows.filter((row) => row.status === "down").map((row) => row.label);
}

export function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? "n/a" : `${latencyMs} ms`;
}
