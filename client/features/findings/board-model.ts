import type { FindingStatus, FindingSummary } from "@/lib/api/types";
import { FINDING_STATUSES } from "./detail-schemas";
import type { BoardColumns } from "./use-board-columns";

export interface OptimisticMove {
  findingId: string;
  to: FindingStatus;
  knownGapReason: string | null;
}

export type CardsByStatus = Readonly<Record<FindingStatus, readonly FindingSummary[]>>;

export type StatusDeltas = Readonly<Record<FindingStatus, number>>;

export function flattenColumns(columns: BoardColumns): FindingSummary[] {
  const seen = new Set<string>();
  const cards: FindingSummary[] = [];
  for (const status of FINDING_STATUSES) {
    for (const card of columns[status].cards) {
      if (!seen.has(card.id)) {
        seen.add(card.id);
        cards.push(card);
      }
    }
  }
  return cards;
}

export function reorderForMove(
  current: readonly FindingSummary[],
  move: OptimisticMove,
): FindingSummary[] {
  const target = current.find((card) => card.id === move.findingId);
  if (target === undefined) {
    return [...current];
  }
  const moved: FindingSummary = {
    ...target,
    status: move.to,
    known_gap_reason: move.to === "known_gap" ? move.knownGapReason : target.known_gap_reason,
  };
  return [moved, ...current.filter((card) => card.id !== move.findingId)];
}

export function groupByStatus(cards: readonly FindingSummary[]): CardsByStatus {
  return {
    new: cards.filter((card) => card.status === "new"),
    triaged: cards.filter((card) => card.status === "triaged"),
    in_fix: cards.filter((card) => card.status === "in_fix"),
    verifying: cards.filter((card) => card.status === "verifying"),
    resolved: cards.filter((card) => card.status === "resolved"),
    known_gap: cards.filter((card) => card.status === "known_gap"),
    dismissed: cards.filter((card) => card.status === "dismissed"),
  };
}

export function movedIds(
  base: readonly FindingSummary[],
  optimistic: readonly FindingSummary[],
): ReadonlySet<string> {
  const baseStatus = new Map(base.map((card) => [card.id, card.status]));
  return new Set(
    optimistic.filter((card) => baseStatus.get(card.id) !== card.status).map((card) => card.id),
  );
}

export function moveDeltas(
  base: readonly FindingSummary[],
  optimistic: readonly FindingSummary[],
): StatusDeltas {
  const deltas: Record<FindingStatus, number> = {
    new: 0,
    triaged: 0,
    in_fix: 0,
    verifying: 0,
    resolved: 0,
    known_gap: 0,
    dismissed: 0,
  };
  const baseStatus = new Map(base.map((card) => [card.id, card.status]));
  for (const card of optimistic) {
    const from = baseStatus.get(card.id);
    if (from !== undefined && from !== card.status) {
      deltas[from] -= 1;
      deltas[card.status] += 1;
    }
  }
  return deltas;
}
