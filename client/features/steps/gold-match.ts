export interface GoldMatch {
  found: boolean;
  occurrences: number;
}

export interface AnswerSegment {
  text: string;
  matched: boolean;
}

interface MatchRange {
  start: number;
  end: number;
}

function keepsLength(text: string): boolean {
  return text.toLowerCase().length === text.length;
}

export function matchRanges(answer: string, rendered: string): MatchRange[] {
  const needle = rendered.trim();
  if (needle === "" || answer === "") {
    return [];
  }
  const insensitive = keepsLength(answer) && keepsLength(needle);
  const haystack = insensitive ? answer.toLowerCase() : answer;
  const wanted = insensitive ? needle.toLowerCase() : needle;
  const ranges: MatchRange[] = [];
  let from = 0;
  while (from <= haystack.length - wanted.length) {
    const index = haystack.indexOf(wanted, from);
    if (index === -1) {
      break;
    }
    ranges.push({ start: index, end: index + wanted.length });
    from = index + wanted.length;
  }
  return ranges;
}

export function matchGoldPoint(rendered: string, answer: string | null): GoldMatch | null {
  if (answer === null) {
    return null;
  }
  const occurrences = matchRanges(answer, rendered).length;
  return { found: occurrences > 0, occurrences };
}

function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function highlightAnswer(
  answer: string,
  renderedValues: readonly string[],
): AnswerSegment[] {
  if (answer === "") {
    return [];
  }
  const merged = mergeRanges(renderedValues.flatMap((rendered) => matchRanges(answer, rendered)));
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) {
      segments.push({ text: answer.slice(cursor, range.start), matched: false });
    }
    segments.push({ text: answer.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < answer.length) {
    segments.push({ text: answer.slice(cursor), matched: false });
  }
  return segments;
}

export function countFound(
  renderedValues: readonly string[],
  answer: string | null,
): number | null {
  if (answer === null) {
    return null;
  }
  return renderedValues.filter((rendered) => matchGoldPoint(rendered, answer)?.found === true)
    .length;
}
