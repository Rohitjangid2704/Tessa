import { parseTimestamp } from "@/components/date-time";
import type { KnownStreamEvent } from "@/features/streams/events";

export const EVENT_FAMILIES = [
  "run",
  "progress",
  "scenario",
  "step",
  "browser",
  "seed",
  "hello",
  "other",
] as const;

export type EventFamily = (typeof EVENT_FAMILIES)[number];

export type LogFamily = EventFamily | "stream";

export const ALWAYS_LISTED_FAMILIES: readonly EventFamily[] = [
  "run",
  "progress",
  "scenario",
  "step",
  "browser",
];

export const EVENT_FAMILY_LABELS: Readonly<Record<EventFamily, string>> = {
  run: "Run",
  progress: "Progress",
  scenario: "Scenarios",
  step: "Steps",
  browser: "Browser",
  seed: "Seed",
  hello: "Hello",
  other: "Other",
};

export type FamilyCounts = Readonly<Record<EventFamily, number>>;

export interface LogRow {
  key: string;
  event: KnownStreamEvent;
  family: LogFamily;
}

export interface LogRowsInput {
  events: readonly KnownStreamEvent[];
  streamEvents: readonly KnownStreamEvent[];
  families: ReadonlySet<EventFamily>;
  showStream: boolean;
}

export const RAW_JSON_LIMIT = 8000;

export function eventFamily(type: string): LogFamily {
  if (type.startsWith("stream.")) {
    return "stream";
  }
  if (type === "run.progress" || type === "budget.updated") {
    return "progress";
  }
  if (type.startsWith("run.") || type.startsWith("budget.")) {
    return "run";
  }
  if (type.startsWith("scenario.")) {
    return "scenario";
  }
  if (type.startsWith("step.")) {
    return "step";
  }
  if (type.startsWith("browser_session.") || type.startsWith("tile.")) {
    return "browser";
  }
  if (type.startsWith("seed.")) {
    return "seed";
  }
  if (type.startsWith("hello.")) {
    return "hello";
  }
  return "other";
}

export function countFamilies(events: readonly KnownStreamEvent[]): FamilyCounts {
  const counts: Record<EventFamily, number> = {
    run: 0,
    progress: 0,
    scenario: 0,
    step: 0,
    browser: 0,
    seed: 0,
    hello: 0,
    other: 0,
  };
  for (const event of events) {
    const family = eventFamily(event.type);
    if (family !== "stream") {
      counts[family] += 1;
    }
  }
  return counts;
}

export function listedFamilies(
  counts: FamilyCounts,
  selected: ReadonlySet<EventFamily>,
): readonly EventFamily[] {
  return EVENT_FAMILIES.filter(
    (family) =>
      ALWAYS_LISTED_FAMILIES.includes(family) || counts[family] > 0 || selected.has(family),
  );
}

function matchesFamilies(family: LogFamily, selected: ReadonlySet<EventFamily>): boolean {
  if (selected.size === 0) {
    return true;
  }
  return family !== "stream" && selected.has(family);
}

function timeOf(event: KnownStreamEvent): number {
  const parsed = Date.parse(event.ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function persistedKey(event: KnownStreamEvent): string {
  return event.seq === null ? `${event.ts}:${event.type}` : `seq:${event.seq}`;
}

function toStreamRows(events: readonly KnownStreamEvent[]): LogRow[] {
  const occurrences = new Map<string, number>();
  return events.map((event) => {
    const base = `stream:${event.ts}:${event.type}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}:${occurrence}`, event, family: "stream" };
  });
}

function mergeByTime(persisted: readonly LogRow[], stream: readonly LogRow[]): LogRow[] {
  const merged: LogRow[] = [];
  let persistedIndex = 0;
  let streamIndex = 0;
  while (persistedIndex < persisted.length && streamIndex < stream.length) {
    const left = persisted[persistedIndex];
    const right = stream[streamIndex];
    if (left === undefined || right === undefined) {
      break;
    }
    if (timeOf(right.event) < timeOf(left.event)) {
      merged.push(right);
      streamIndex += 1;
    } else {
      merged.push(left);
      persistedIndex += 1;
    }
  }
  return merged.concat(persisted.slice(persistedIndex), stream.slice(streamIndex));
}

export function buildLogRows({
  events,
  streamEvents,
  families,
  showStream,
}: LogRowsInput): LogRow[] {
  const persisted: LogRow[] = [];
  for (const event of events) {
    const family = eventFamily(event.type);
    if (matchesFamilies(family, families)) {
      persisted.push({ key: persistedKey(event), event, family });
    }
  }
  if (!showStream || streamEvents.length === 0) {
    return persisted;
  }
  return mergeByTime(persisted, toStreamRows(streamEvents));
}

export function countRowsAfterSeq(rows: readonly LogRow[], seq: number): number {
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) {
      break;
    }
    if (row.event.seq !== null && row.event.seq <= seq) {
      break;
    }
    count += 1;
  }
  return count;
}

const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatEventClock(ts: string): string {
  const parsed = parseTimestamp(ts);
  return parsed === null ? ts : clockFormatter.format(parsed);
}

export function formatEventJson(event: KnownStreamEvent): string {
  return JSON.stringify(event, null, 2);
}

export function previewJson(text: string): string {
  if (text.length <= RAW_JSON_LIMIT) {
    return text;
  }
  return `${text.slice(0, RAW_JSON_LIMIT)}\n... truncated, ${text.length - RAW_JSON_LIMIT} more characters`;
}
