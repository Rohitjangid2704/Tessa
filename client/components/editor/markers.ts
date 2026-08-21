import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { ScenarioIssue } from "@/lib/api/types";
import {
  TESSA_MARKER_OWNER,
  type EditorMarkerInput,
  type EditorMarkerSeverity,
} from "./editor-types";

export const MARKER_OWNER = TESSA_MARKER_OWNER;

export interface TextPosition {
  line: number;
  column: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export type PointerResolver = (pointer: string) => TextRange | null;

const POINTER_SEPARATOR = "/";
const MIN_MARKER_WIDTH = 1;

export function parsePointer(pointer: string): string[] | null {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith(POINTER_SEPARATOR)) {
    return null;
  }
  return pointer
    .slice(1)
    .split(POINTER_SEPARATOR)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function offsetRange(node: unknown): [number, number] | null {
  if (!isNode(node) || node.range === null || node.range === undefined) {
    return null;
  }
  return [node.range[0], node.range[1]];
}

function findRange(contents: unknown, segments: readonly string[]): [number, number] | null {
  let node: unknown = contents;
  let found = offsetRange(node);
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === segment);
      if (pair === undefined) {
        break;
      }
      if (isLast) {
        found = offsetRange(pair.key) ?? offsetRange(pair.value) ?? found;
        break;
      }
      node = pair.value;
      found = offsetRange(node) ?? offsetRange(pair.key) ?? found;
    } else if (isSeq(node)) {
      const position = Number(segment);
      const item: unknown = Number.isInteger(position) ? node.items[position] : undefined;
      if (item === undefined) {
        break;
      }
      node = item;
      found = offsetRange(node) ?? found;
    } else {
      break;
    }
  }
  return found;
}

function lineEndOffset(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

export function createPointerResolver(text: string): PointerResolver {
  const lineCounter = new LineCounter();
  let contents: unknown = null;
  try {
    contents = parseDocument(text, { lineCounter }).contents;
  } catch {
    return () => null;
  }
  return (pointer) => {
    const segments = parsePointer(pointer);
    if (segments === null) {
      return null;
    }
    const range = findRange(contents, segments);
    if (range === null) {
      return null;
    }
    const [start, valueEnd] = range;
    const end = Math.max(start + MIN_MARKER_WIDTH, Math.min(valueEnd, lineEndOffset(text, start)));
    const from = lineCounter.linePos(start);
    const to = lineCounter.linePos(Math.min(end, text.length));
    return {
      start: { line: from.line, column: from.col },
      end: { line: to.line, column: to.col },
    };
  };
}

function lineLength(text: string, line: number): number {
  return text.split("\n")[line - 1]?.length ?? 0;
}

function rangeOfLine(text: string, line: number, column: number): TextRange {
  const lines = text.split("\n").length;
  const clampedLine = Math.min(Math.max(line, 1), lines);
  const startColumn = Math.max(column, 1);
  const endColumn = Math.max(startColumn + MIN_MARKER_WIDTH, lineLength(text, clampedLine) + 1);
  return {
    start: { line: clampedLine, column: startColumn },
    end: { line: clampedLine, column: endColumn },
  };
}

export function resolveIssueRange(
  issue: ScenarioIssue,
  text: string,
  resolve: PointerResolver,
): TextRange {
  if (issue.line !== null) {
    return rangeOfLine(text, issue.line, issue.column ?? 1);
  }
  const fromPointer = issue.pointer === null ? null : resolve(issue.pointer);
  return fromPointer ?? rangeOfLine(text, 1, 1);
}

export function issuesToMarkers(
  issues: readonly ScenarioIssue[],
  text: string,
  severity: EditorMarkerSeverity,
): EditorMarkerInput[] {
  if (issues.length === 0) {
    return [];
  }
  const resolve = createPointerResolver(text);
  return issues.map((issue) => {
    const range = resolveIssueRange(issue, text, resolve);
    return {
      severity,
      message: issue.message,
      startLine: range.start.line,
      startColumn: range.start.column,
      endLine: range.end.line,
      endColumn: range.end.column,
      code: issue.code,
    };
  });
}

export function describeIssueLocation(
  issue: ScenarioIssue,
  resolve: PointerResolver,
): string | null {
  if (issue.line !== null) {
    return issue.column === null
      ? `line ${issue.line}`
      : `line ${issue.line}, column ${issue.column}`;
  }
  const range = issue.pointer === null ? null : resolve(issue.pointer);
  return range === null ? null : `line ${range.start.line}, column ${range.start.column}`;
}
