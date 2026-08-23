import type { KnownStreamEvent } from "@/features/streams/events";
import { isRunTerminal } from "@/lib/api/polling";
import type {
  ContractCheck,
  ContractDiff,
  ContractProgressPayload,
  VerdictStatus,
} from "@/lib/api/types";

export const CONTRACT_VERDICT_ORDER = [
  "fail",
  "uncertain",
  "flaky",
  "skipped",
  "pass",
] as const satisfies readonly VerdictStatus[];

export type VerdictCounts = Record<VerdictStatus, number>;

export interface KeyedItem {
  key: string;
  item: ContractDiff;
}

export type ItemListRow =
  | { kind: "group"; key: string; interfaceId: string; counts: VerdictCounts }
  | { kind: "item"; key: string; interfaceId: string; item: ContractDiff };

export type CheckOutcome = "in_progress" | "unfinished" | "breaking" | "undecided" | "compatible";

const VERDICT_RANK: Record<VerdictStatus, number> = {
  fail: 0,
  uncertain: 1,
  flaky: 2,
  skipped: 3,
  pass: 4,
};

export function emptyVerdictCounts(): VerdictCounts {
  return { fail: 0, uncertain: 0, flaky: 0, skipped: 0, pass: 0 };
}

export function countVerdicts(items: readonly Pick<ContractDiff, "verdict">[]): VerdictCounts {
  const counts = emptyVerdictCounts();
  for (const entry of items) {
    counts[entry.verdict] += 1;
  }
  return counts;
}

export function isCheckSettled(check: Pick<ContractCheck, "status">): boolean {
  return isRunTerminal(check);
}

export function describeCheckOutcome(check: ContractCheck): CheckOutcome {
  if (!isCheckSettled(check)) {
    return "in_progress";
  }
  if (check.status !== "completed") {
    return "unfinished";
  }
  const counts = countVerdicts(check.items);
  if (check.breaking > 0 || counts.fail > 0) {
    return "breaking";
  }
  return counts.uncertain > 0 ? "undecided" : "compatible";
}

export function keyItems(items: readonly ContractDiff[]): KeyedItem[] {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const base = `${item.interface_id}|${item.path}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}|${occurrence}`, item };
  });
}

export function filterKeyedItems(
  keyed: readonly KeyedItem[],
  verdicts: readonly VerdictStatus[] | undefined,
): KeyedItem[] {
  if (verdicts === undefined || verdicts.length === 0) {
    return [...keyed];
  }
  return keyed.filter((entry) => verdicts.includes(entry.item.verdict));
}

function compareKeyedItems(left: KeyedItem, right: KeyedItem): number {
  return VERDICT_RANK[left.item.verdict] - VERDICT_RANK[right.item.verdict];
}

interface InterfaceGroup {
  interfaceId: string;
  members: KeyedItem[];
  counts: VerdictCounts;
  rank: number;
}

function toGroup(interfaceId: string, members: KeyedItem[]): InterfaceGroup {
  const ordered = [...members].sort(compareKeyedItems);
  const first = ordered[0];
  return {
    interfaceId,
    members: ordered,
    counts: countVerdicts(ordered.map((entry) => entry.item)),
    rank: first === undefined ? Number.POSITIVE_INFINITY : VERDICT_RANK[first.item.verdict],
  };
}

function compareGroups(left: InterfaceGroup, right: InterfaceGroup): number {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  return left.interfaceId.localeCompare(right.interfaceId);
}

export function buildItemRows(keyed: readonly KeyedItem[]): ItemListRow[] {
  const byInterface = new Map<string, KeyedItem[]>();
  for (const entry of keyed) {
    const bucket = byInterface.get(entry.item.interface_id);
    if (bucket === undefined) {
      byInterface.set(entry.item.interface_id, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  const groups = [...byInterface.entries()]
    .map(([interfaceId, members]) => toGroup(interfaceId, members))
    .sort(compareGroups);
  return groups.flatMap((group): ItemListRow[] => [
    {
      kind: "group",
      key: `group|${group.interfaceId}`,
      interfaceId: group.interfaceId,
      counts: group.counts,
    },
    ...group.members.map(
      (entry): ItemListRow => ({
        kind: "item",
        key: entry.key,
        interfaceId: group.interfaceId,
        item: entry.item,
      }),
    ),
  ]);
}

export function isItemOpenByDefault(item: Pick<ContractDiff, "verdict">): boolean {
  return item.verdict === "fail";
}

export interface CheckProgress {
  itemsDone: number;
  itemsTotal: number | null;
  breaking: number;
}

export function progressFromCheck(check: ContractCheck): CheckProgress {
  return { itemsDone: check.items.length, itemsTotal: null, breaking: check.breaking };
}

export function progressFromPayload(payload: ContractProgressPayload): CheckProgress {
  return {
    itemsDone: payload.items_done,
    itemsTotal: payload.items_total,
    breaking: payload.breaking,
  };
}

export function latestContractProgress(
  events: readonly KnownStreamEvent[],
): ContractProgressPayload | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === "contract.progress") {
      return event.payload;
    }
  }
  return null;
}

export function progressPercent(progress: CheckProgress): number | null {
  if (progress.itemsTotal === null) {
    return null;
  }
  if (progress.itemsTotal <= 0) {
    return 100;
  }
  return Math.round(Math.min(1, progress.itemsDone / progress.itemsTotal) * 100);
}

export function describeProgress(progress: CheckProgress): string {
  const compared =
    progress.itemsTotal === null
      ? `${progress.itemsDone} ${progress.itemsDone === 1 ? "item" : "items"} compared`
      : `${progress.itemsDone} of ${progress.itemsTotal} items compared`;
  return `${compared}, ${progress.breaking} breaking so far`;
}
