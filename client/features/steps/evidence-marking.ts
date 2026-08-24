export type MarkKind = "gold" | "forbidden" | "unsupported";

export interface Needle {
  text: string;
  kind: MarkKind;
}

export interface Segment {
  text: string;
  kind: MarkKind | null;
}

interface MatchRange {
  start: number;
  end: number;
  kind: MarkKind;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function boundaryPattern(needle: string): RegExp {
  const escaped = needle.replace(REGEX_SPECIALS, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

export function dedupeNeedles(needles: readonly Needle[]): Needle[] {
  const seen = new Set<string>();
  const unique: Needle[] = [];
  for (const needle of needles) {
    const text = needle.text.trim();
    const key = `${needle.kind}:${text.toLowerCase()}`;
    if (text !== "" && !seen.has(key)) {
      seen.add(key);
      unique.push({ kind: needle.kind, text });
    }
  }
  return unique;
}

export function findOccurrences(text: string, needle: string): number[] {
  const trimmed = needle.trim();
  if (trimmed === "" || text === "") {
    return [];
  }
  const starts: number[] = [];
  for (const match of text.matchAll(boundaryPattern(trimmed))) {
    starts.push(match.index);
  }
  return starts;
}

export function appearsIn(text: string, needle: string): boolean {
  return findOccurrences(text, needle).length > 0;
}

function collectRanges(text: string, needles: readonly Needle[]): MatchRange[] {
  return needles.flatMap((needle) =>
    findOccurrences(text, needle.text).map((start) => ({
      start,
      end: start + needle.text.trim().length,
      kind: needle.kind,
    })),
  );
}

function dropOverlaps(ranges: readonly MatchRange[]): MatchRange[] {
  const ordered = [...ranges].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const kept: MatchRange[] = [];
  let lastEnd = 0;
  for (const range of ordered) {
    if (range.start >= lastEnd) {
      kept.push(range);
      lastEnd = range.end;
    }
  }
  return kept;
}

export function markSegments(text: string, needles: readonly Needle[]): Segment[] {
  const ranges = dropOverlaps(collectRanges(text, dedupeNeedles(needles)));
  const segments: Segment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), kind: null });
    }
    segments.push({ text: text.slice(range.start, range.end), kind: range.kind });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), kind: null });
  }
  return segments.length === 0 ? [{ text, kind: null }] : segments;
}

export function truncateSegments(segments: readonly Segment[], limit: number): Segment[] {
  const kept: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= limit) {
      break;
    }
    const room = limit - used;
    kept.push(
      segment.text.length <= room ? segment : { ...segment, text: segment.text.slice(0, room) },
    );
    used += Math.min(segment.text.length, room);
  }
  return kept;
}
