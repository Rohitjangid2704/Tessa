import type { CoverageCell } from "@/lib/api/types";

let counter = 0;

export function buildCoverageCell(overrides: Partial<CoverageCell> = {}): CoverageCell {
  counter += 1;
  return {
    id: `0198f6f2-4c2a-7d10-9c1e-${String(counter).padStart(12, "0")}`,
    plan_id: "0198f6f2-4c2a-7d10-9c1e-bbbbbbbbbbbb",
    feature_id: "smart_log.read.open_maintenance",
    role: "guest",
    interface_id: "chat_sse",
    family: "smart-log",
    status: "empty",
    scenario_count: 0,
    last_verdict: null,
    reason: null,
    skip_reason: null,
    ...overrides,
  };
}
