import type { Proposal, ProposalItem } from "@/lib/api/types";

let counter = 0;

export function buildProposalItem(overrides: Partial<ProposalItem> = {}): ProposalItem {
  counter += 1;
  return {
    id: `0198f6f2-4c2a-7d10-9c1e-${String(counter).padStart(12, "0")}`,
    key: `item-${counter}`,
    title: `Item ${counter}`,
    area: "Smart Log",
    feature_ids: ["smart_log.read.open_maintenance"],
    interface_id: null,
    kind: "api",
    risk: "medium",
    reasons: [{ code: "recent_change", note: "Touched in 4 commits" }],
    needs: [],
    depth: "standard",
    estimate: { scenarios: 4, minutes: 6 },
    confidence: "medium",
    evidence: "src/smart_log/handlers.py",
    status: "proposed",
    note: null,
    selected_by: null,
    selected_at: null,
    cell_ids: [],
    scenario_ids: [],
    ...overrides,
  };
}

export function buildProposal(items: ProposalItem[], overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "0198f6f2-4c2a-7d10-9c1e-aaaaaaaaaaaa",
    target_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9001",
    bundle_id: null,
    commit_sha: null,
    branch: null,
    generated_at: "2026-10-08T10:00:00.000Z",
    source: "bundle",
    created_by: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e01",
    created_at: "2026-10-08T10:00:00.000Z",
    stale: false,
    items,
    ...overrides,
  };
}
