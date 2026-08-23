import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { z } from "zod";
import { SEVERITIES } from "@/components/status/status-types";
import type { KnownStreamEvent, StreamEventOf } from "@/features/streams/events";
import { qk } from "@/lib/api/query-keys";
import type { Finding, FindingPage, FindingStatus, FindingSummary } from "@/lib/api/types";
import {
  applyFindingChanges,
  FINDING_STATUSES,
  readStatusMove,
  type FindingChanges,
  type StatusMove,
} from "./detail-schemas";
import { isLocalMove } from "./local-moves";
import type { FindingBoardFilters } from "./schemas";
import { recordSystemMove } from "./system-moves";

type FindingListData = InfiniteData<FindingPage, string | null>;

type ListScope = FindingBoardFilters & { target_id?: string };

const FILTERS_KEY_POSITION = 2;
const STATUS_KEY_POSITION = 3;

const statusSchema = z.enum(FINDING_STATUSES);
const severitySchema = z.enum(SEVERITIES);
const nullableTextSchema = z.string().nullable();

export function scopeOfListKey(key: QueryKey): ListScope {
  const candidate: unknown = key[FILTERS_KEY_POSITION];
  return typeof candidate === "object" && candidate !== null ? (candidate as ListScope) : {};
}

export function statusOfListKey(key: QueryKey): FindingStatus | null {
  const candidate: unknown = key[STATUS_KEY_POSITION];
  return FINDING_STATUSES.find((status) => status === candidate) ?? null;
}

function hasEntries<Item>(values: readonly Item[] | undefined): values is readonly Item[] {
  return values !== undefined && values.length > 0;
}

export function cardMatchesScope(card: FindingSummary, scope: ListScope): boolean {
  if (scope.target_id !== undefined && scope.target_id !== card.target_id) {
    return false;
  }
  if (hasEntries(scope.severity) && !scope.severity.some((value) => value === card.severity)) {
    return false;
  }
  if (hasEntries(scope.class) && !scope.class.some((value) => value === card.class)) {
    return false;
  }
  if (
    hasEntries(scope.invariant_id) &&
    (card.invariant_id === null || !scope.invariant_id.some((value) => value === card.invariant_id))
  ) {
    return false;
  }
  return scope.run_id === undefined && scope.q === undefined;
}

function patchedSummary(card: FindingSummary, changes: FindingChanges): FindingSummary {
  const status = statusSchema.safeParse(changes.status?.to);
  const severity = severitySchema.safeParse(changes.severity?.to);
  const ticketUrl = nullableTextSchema.safeParse(changes.ticket_url?.to);
  const knownGapReason = nullableTextSchema.safeParse(changes.known_gap_reason?.to);
  return {
    ...card,
    status: status.success ? status.data : card.status,
    severity: severity.success ? severity.data : card.severity,
    ticket_url: ticketUrl.success ? ticketUrl.data : card.ticket_url,
    known_gap_reason: knownGapReason.success ? knownGapReason.data : card.known_gap_reason,
  };
}

function findCard(data: FindingListData, findingId: string): FindingSummary | null {
  for (const page of data.pages) {
    const found = page.items.find((item) => item.id === findingId);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

function mapCards(
  data: FindingListData,
  findingId: string,
  patch: (card: FindingSummary) => FindingSummary,
): FindingListData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === findingId ? patch(item) : item)),
    })),
  };
}

function removeCard(data: FindingListData, findingId: string): FindingListData {
  return {
    ...data,
    pages: data.pages.map((page) => {
      const items = page.items.filter((item) => item.id !== findingId);
      const removed = page.items.length - items.length;
      return {
        ...page,
        items,
        total: page.total === null ? null : Math.max(0, page.total - removed),
      };
    }),
  };
}

function prependCard(data: FindingListData, card: FindingSummary): FindingListData {
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === 0
        ? {
            ...page,
            items: [card, ...page.items],
            total: page.total === null ? null : page.total + 1,
          }
        : page,
    ),
  };
}

function patchDetail(
  queryClient: QueryClient,
  findingId: string,
  patch: (finding: Finding) => Finding,
): void {
  queryClient.setQueryData<Finding>(qk.findings.detail(findingId), (previous) =>
    previous === undefined ? previous : patch(previous),
  );
}

function applyMove(
  queryClient: QueryClient,
  findingId: string,
  move: StatusMove,
  moved: FindingSummary | null,
): void {
  for (const [key, data] of queryClient.getQueriesData<FindingListData>({
    queryKey: qk.findings.lists(),
  })) {
    if (data === undefined || data.pages.length === 0) {
      continue;
    }
    const status = statusOfListKey(key);
    if (status === move.from && findCard(data, findingId) !== null) {
      queryClient.setQueryData<FindingListData>(key, removeCard(data, findingId));
    } else if (
      status === move.to &&
      moved !== null &&
      findCard(data, findingId) === null &&
      cardMatchesScope(moved, scopeOfListKey(key))
    ) {
      queryClient.setQueryData<FindingListData>(key, prependCard(data, moved));
    }
  }
  void queryClient.invalidateQueries({
    queryKey: qk.findings.lists(),
    predicate: (query) => {
      const status = statusOfListKey(query.queryKey);
      return status === move.from || status === move.to;
    },
  });
}

function applyUpdated(queryClient: QueryClient, event: StreamEventOf<"finding.updated">): void {
  const { finding_id: findingId, changes } = event.payload;
  const move = readStatusMove(changes);
  const localMove = move !== null && isLocalMove(findingId, move.to, Date.now());
  const statusChange = move !== null && move.from !== move.to && !localMove;
  const effective: FindingChanges = statusChange
    ? changes
    : Object.fromEntries(Object.entries(changes).filter(([field]) => field !== "status"));

  let moved: FindingSummary | null = null;
  for (const [key, data] of queryClient.getQueriesData<FindingListData>({
    queryKey: qk.findings.lists(),
  })) {
    if (data === undefined) {
      continue;
    }
    const card = findCard(data, findingId);
    if (card === null) {
      continue;
    }
    const patched = patchedSummary(card, effective);
    moved ??= patched;
    if (statusOfListKey(key) === card.status) {
      queryClient.setQueryData<FindingListData>(
        key,
        mapCards(data, findingId, () => patched),
      );
    }
  }

  patchDetail(queryClient, findingId, (finding) => applyFindingChanges(finding, effective));

  if (statusChange) {
    recordSystemMove(findingId, move, event.ts);
    applyMove(queryClient, findingId, move, moved);
  }
}

function applyOccurrenceAdded(
  queryClient: QueryClient,
  event: StreamEventOf<"finding.occurrence_added">,
): void {
  const { finding_id: findingId, occurrence_count: occurrenceCount, run_id: runId } = event.payload;
  queryClient.setQueriesData<FindingListData>({ queryKey: qk.findings.lists() }, (data) =>
    data === undefined
      ? data
      : mapCards(data, findingId, (card) => ({
          ...card,
          occurrence_count: occurrenceCount,
          last_seen_at: event.ts,
        })),
  );
  patchDetail(queryClient, findingId, (finding) => ({
    ...finding,
    occurrence_count: occurrenceCount,
    last_seen_run_id: runId,
    last_seen_at: event.ts,
  }));
  void queryClient.invalidateQueries({ queryKey: qk.findings.occurrences(findingId) });
}

export function applyFindingFeedEvent(queryClient: QueryClient, event: KnownStreamEvent): void {
  switch (event.type) {
    case "finding.updated":
      applyUpdated(queryClient, event);
      return;
    case "finding.occurrence_added":
      applyOccurrenceAdded(queryClient, event);
      return;
    default:
      return;
  }
}
