import type { ErrorDetail } from "../types";
import { MockApiError, validationFailed } from "./errors";
import { isUuid } from "./ids";
import { FieldValidator } from "./validation";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_CURSOR_LENGTH = 2048;

const PAGE_KEYS = ["limit", "cursor", "include_total", "sort"] as const;
const TRUE_STRINGS = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_STRINGS = new Set(["0", "off", "f", "false", "n", "no"]);
const textCollator = new Intl.Collator("en");

export type SortValue = string | number;
export type SortKind = "text" | "number" | "timestamp";

export interface SortKey<Row> {
  kind: SortKind;
  value: (row: Row) => SortValue;
}

export interface PageSpec<Row> {
  sortKeys: Readonly<Record<string, SortKey<Row>>>;
  defaultSort: string;
  getId: (row: Row) => string;
}

export interface SortTerm {
  key: string;
  descending: boolean;
}

export interface PageRequest {
  limit: number;
  cursor: string | null;
  includeTotal: boolean;
  sort: string | null;
}

export interface Page<Row> {
  items: Row[];
  next_cursor: string | null;
  total: number | null;
}

function joinOptions(options: readonly string[]): string {
  const quoted = options.map((option) => `'${option}'`);
  const last = quoted[quoted.length - 1] ?? "";
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${last}` : last;
}

export function parseBooleanText(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (TRUE_STRINGS.has(normalized)) {
    return true;
  }
  return FALSE_STRINGS.has(normalized) ? false : null;
}

export function unknownParameter(name: string, code: string, message: string): MockApiError {
  return validationFailed([{ loc: ["query", name], code, message }]);
}

export class QueryReader {
  readonly details: ErrorDetail[] = [];
  private readonly params: URLSearchParams;
  private readonly declared = new Set<string>();
  private readonly validator: FieldValidator;

  constructor(params: URLSearchParams) {
    this.params = params;
    this.validator = new FieldValidator("query", this.details);
  }

  private issue(key: string, code: string, message: string, index?: number): void {
    const loc = index === undefined ? ["query", key] : ["query", key, index];
    this.details.push({ loc, code, message });
  }

  text(key: string, rules: { max?: number } = {}): string | undefined {
    this.declared.add(key);
    const value = this.params.get(key);
    if (value === null) {
      return undefined;
    }
    if (rules.max !== undefined && value.length > rules.max) {
      this.issue(
        key,
        "string_too_long",
        `String should have at most ${rules.max} character${rules.max === 1 ? "" : "s"}`,
      );
      return undefined;
    }
    return value;
  }

  uuid(key: string, rules: { required?: boolean } = {}): string | undefined {
    this.declared.add(key);
    const value = this.params.get(key);
    if (value === null) {
      if (rules.required) {
        this.issue(key, "missing", "Field required");
      }
      return undefined;
    }
    if (!isUuid(value)) {
      this.issue(
        key,
        "uuid_parsing",
        "Input should be a valid UUID, invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found a non-hexadecimal character",
      );
      return undefined;
    }
    return value;
  }

  integer(key: string, rules: { min?: number; max?: number } = {}): number | undefined {
    this.declared.add(key);
    return this.validator.queryInteger(this.params.get(key), key, rules);
  }

  boolean(key: string, fallback: boolean): boolean {
    this.declared.add(key);
    const raw = this.params.get(key);
    if (raw === null) {
      return fallback;
    }
    const parsed = parseBooleanText(raw);
    if (parsed === null) {
      this.issue(key, "bool_parsing", "Input should be a valid boolean, unable to interpret input");
      return fallback;
    }
    return parsed;
  }

  enumList<Value extends string>(key: string, allowed: readonly Value[]): Value[] | undefined {
    this.declared.add(key);
    const raw = this.params.getAll(key);
    if (raw.length === 0) {
      return undefined;
    }
    const accepted: Value[] = [];
    raw.forEach((candidate, index) => {
      const match = allowed.find((option) => option === candidate);
      if (match === undefined) {
        this.issue(key, "enum", `Input should be ${joinOptions(allowed)}`, index);
      } else {
        accepted.push(match);
      }
    });
    return accepted;
  }

  stringList(key: string): string[] | undefined {
    this.declared.add(key);
    const raw = this.params.getAll(key);
    return raw.length === 0 ? undefined : raw;
  }

  page(): PageRequest {
    for (const key of PAGE_KEYS) {
      this.declared.add(key);
    }
    const limit = this.validator.queryInteger(this.params.get("limit"), "limit", {
      min: 1,
      max: MAX_PAGE_LIMIT,
      fallback: DEFAULT_PAGE_LIMIT,
    });
    const cursor = this.params.get("cursor");
    if (cursor !== null && cursor.length > MAX_CURSOR_LENGTH) {
      this.issue(
        "cursor",
        "string_too_long",
        `String should have at most ${MAX_CURSOR_LENGTH} characters`,
      );
    }
    return {
      limit: limit ?? DEFAULT_PAGE_LIMIT,
      cursor,
      includeTotal: this.boolean("include_total", false),
      sort: this.params.get("sort"),
    };
  }

  finish(): void {
    if (this.details.length > 0) {
      throw validationFailed(this.details);
    }
    const unknown = [...new Set(this.params.keys())]
      .filter((key) => !this.declared.has(key))
      .sort();
    if (unknown.length > 0) {
      throw validationFailed(
        unknown.map((key) => ({
          loc: ["query", key],
          code: "unknown_query_parameter",
          message: `Unknown query parameter '${key}'`,
        })),
      );
    }
  }
}

export function parseSort(raw: string, allowed: readonly string[]): SortTerm[] {
  const terms: SortTerm[] = [];
  for (const part of raw.split(",")) {
    const text = part.trim();
    const descending = text.startsWith("-");
    const key = descending ? text.slice(1) : text;
    if (key === "") {
      throw unknownParameter("sort", "invalid_sort", "Empty sort key");
    }
    if (!allowed.includes(key)) {
      throw unknownParameter(
        "sort",
        "unknown_sort_key",
        `Unknown sort key '${key}'; allowed: ${allowed.join(", ")}`,
      );
    }
    if (terms.some((term) => term.key === key)) {
      throw unknownParameter("sort", "duplicate_sort_key", `Duplicate sort key '${key}'`);
    }
    terms.push({ key, descending });
  }
  return terms;
}

function renderSort(terms: readonly SortTerm[]): string {
  return terms.map((term) => (term.descending ? `-${term.key}` : term.key)).join(",");
}

function compareValues(kind: SortKind, left: SortValue, right: SortValue): number {
  if (kind === "text") {
    return textCollator.compare(String(left), String(right));
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function encodeCursor(sortText: string, values: readonly SortValue[]): string {
  return Buffer.from(JSON.stringify({ sort: sortText, values })).toString("base64url");
}

function invalidCursor(): MockApiError {
  return unknownParameter("cursor", "invalid_cursor", "The cursor is not valid");
}

function decodeCursor(cursor: string, sortText: string, kinds: readonly SortKind[]): SortValue[] {
  try {
    const payload: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) {
      throw new Error("payload");
    }
    const sort: unknown = Reflect.get(payload, "sort");
    const values: unknown = Reflect.get(payload, "values");
    if (sort !== sortText || !Array.isArray(values) || values.length !== kinds.length) {
      throw new Error("shape");
    }
    return values.map((value: unknown, index) => {
      const expectsNumber = kinds[index] === "number";
      if (expectsNumber ? typeof value !== "number" : typeof value !== "string") {
        throw new Error("type");
      }
      return value as SortValue;
    });
  } catch {
    throw invalidCursor();
  }
}

export function paginate<Row>(
  rows: readonly Row[],
  request: PageRequest,
  spec: PageSpec<Row>,
): Page<Row> {
  const terms = parseSort(request.sort ?? spec.defaultSort, Object.keys(spec.sortKeys));
  const sortText = renderSort(terms);
  const keys = terms.map((term) => {
    const key = spec.sortKeys[term.key];
    if (key === undefined) {
      throw invalidCursor();
    }
    return key;
  });
  const kinds: SortKind[] = [...keys.map((key) => key.kind), "text"];
  const idDescending = terms[0]?.descending ?? false;
  const rowValues = (row: Row): SortValue[] => [
    ...keys.map((key) => key.value(row)),
    spec.getId(row),
  ];
  const compareTuples = (left: readonly SortValue[], right: readonly SortValue[]): number => {
    for (let index = 0; index < kinds.length; index += 1) {
      const kind = kinds[index] ?? "text";
      const descending = index < terms.length ? (terms[index]?.descending ?? false) : idDescending;
      const result = compareValues(kind, left[index] ?? "", right[index] ?? "");
      if (result !== 0) {
        return descending ? -result : result;
      }
    }
    return 0;
  };

  const ordered = rows
    .map((row) => ({ row, values: rowValues(row) }))
    .sort((left, right) => compareTuples(left.values, right.values));
  const cursorValues =
    request.cursor === null ? null : decodeCursor(request.cursor, sortText, kinds);
  const remaining =
    cursorValues === null
      ? ordered
      : ordered.filter((entry) => compareTuples(entry.values, cursorValues) > 0);
  const slice = remaining.slice(0, request.limit);
  const lastValues = slice[slice.length - 1]?.values;
  const hasMore = remaining.length > request.limit && lastValues !== undefined;
  return {
    items: slice.map((entry) => entry.row),
    next_cursor: hasMore ? encodeCursor(sortText, lastValues) : null,
    total: request.includeTotal ? rows.length : null,
  };
}

export function readPage<Row>(
  query: QueryReader,
  spec: PageSpec<Row>,
): (rows: readonly Row[]) => Page<Row> {
  const request = query.page();
  return (rows) => paginate(rows, request, spec);
}
