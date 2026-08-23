export type JsonType = "string" | "number" | "boolean" | "null" | "object" | "array";

export type StructuralChangeKind =
  | "added"
  | "removed"
  | "type_changed"
  | "value_changed"
  | "reordered";

export interface StructuralChange {
  kind: StructuralChangeKind;
  path: string;
  before: unknown;
  after: unknown;
  beforeType: JsonType | null;
  afterType: JsonType | null;
}

export interface StructuralChangeCounts {
  added: number;
  removed: number;
  type_changed: number;
  value_changed: number;
  reordered: number;
}

type JsonObject = Record<string, unknown>;

type Primitive = string | number | boolean | null;

export const ROOT_PATH_LABEL = "(whole value)";
export const MAX_DIFF_DEPTH = 24;
export const COMPACT_JSON_DEFAULT_MAX_CHARS = 160;

const ARRAY_IDENTITY_KEYS = ["id", "name", "key", "field", "path"] as const;
const PLAIN_PATH_SEGMENT = /^[A-Za-z_$][\w$-]*$/;

export function jsonTypeOf(value: unknown): JsonType {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isPrimitiveArray(value: readonly unknown[]): value is readonly Primitive[] {
  return value.every(isPrimitive);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function compactJson(
  value: unknown,
  maxChars: number = COMPACT_JSON_DEFAULT_MAX_CHARS,
): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

export function joinObjectPath(parent: string, key: string): string {
  const segment = PLAIN_PATH_SEGMENT.test(key) ? key : `[${JSON.stringify(key)}]`;
  if (parent === "") {
    return segment;
  }
  return segment.startsWith("[") ? `${parent}${segment}` : `${parent}.${segment}`;
}

export function joinIndexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

export function joinIdentityPath(
  parent: string,
  identityKey: string,
  identityValue: string | number,
): string {
  return `${parent}[${identityKey}=${identityValue}]`;
}

export function joinMemberPath(parent: string): string {
  return `${parent}[]`;
}

function change(
  kind: StructuralChangeKind,
  path: string,
  before: unknown,
  after: unknown,
): StructuralChange {
  return {
    kind,
    path,
    before,
    after,
    beforeType: before === undefined ? null : jsonTypeOf(before),
    afterType: after === undefined ? null : jsonTypeOf(after),
  };
}

function diffPrimitiveArrayAsSet(
  path: string,
  before: readonly Primitive[],
  after: readonly Primitive[],
  out: StructuralChange[],
): void {
  const memberPath = joinMemberPath(path);
  const beforeKeys = before.map(canonicalJson);
  const afterKeys = after.map(canonicalJson);
  const afterSet = new Set(afterKeys);
  const beforeSet = new Set(beforeKeys);
  const reportedRemoved = new Set<string>();
  const reportedAdded = new Set<string>();
  let membersDiffer = false;
  before.forEach((member, index) => {
    const key = beforeKeys[index] ?? "";
    if (!afterSet.has(key) && !reportedRemoved.has(key)) {
      reportedRemoved.add(key);
      membersDiffer = true;
      out.push(change("removed", memberPath, member, undefined));
    }
  });
  after.forEach((member, index) => {
    const key = afterKeys[index] ?? "";
    if (!beforeSet.has(key) && !reportedAdded.has(key)) {
      reportedAdded.add(key);
      membersDiffer = true;
      out.push(change("added", memberPath, undefined, member));
    }
  });
  if (!membersDiffer && beforeKeys.join("\n") !== afterKeys.join("\n")) {
    out.push(change("reordered", path, before, after));
  }
}

function identityValueOf(element: unknown, identityKey: string): string | number | null {
  if (!isPlainObject(element)) {
    return null;
  }
  const value = element[identityKey];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function hasUniqueIdentities(elements: readonly unknown[], identityKey: string): boolean {
  const seen = new Set<string | number>();
  for (const element of elements) {
    const identity = identityValueOf(element, identityKey);
    if (identity === null || seen.has(identity)) {
      return false;
    }
    seen.add(identity);
  }
  return true;
}

function findSharedIdentityKey(
  before: readonly unknown[],
  after: readonly unknown[],
): string | null {
  if (before.length === 0 || after.length === 0) {
    return null;
  }
  const shared = ARRAY_IDENTITY_KEYS.find(
    (key) => hasUniqueIdentities(before, key) && hasUniqueIdentities(after, key),
  );
  return shared ?? null;
}

function diffObjectArrayByIdentity(
  path: string,
  identityKey: string,
  before: readonly unknown[],
  after: readonly unknown[],
  depth: number,
  out: StructuralChange[],
): void {
  const beforeByIdentity = new Map<string | number, unknown>();
  for (const element of before) {
    const identity = identityValueOf(element, identityKey);
    if (identity !== null) {
      beforeByIdentity.set(identity, element);
    }
  }
  const afterByIdentity = new Map<string | number, unknown>();
  for (const element of after) {
    const identity = identityValueOf(element, identityKey);
    if (identity !== null) {
      afterByIdentity.set(identity, element);
    }
  }
  const identities = [...new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])];
  for (const identity of identities) {
    walk(
      joinIdentityPath(path, identityKey, identity),
      beforeByIdentity.get(identity),
      afterByIdentity.get(identity),
      depth + 1,
      out,
    );
  }
}

function diffArrayByIndex(
  path: string,
  before: readonly unknown[],
  after: readonly unknown[],
  depth: number,
  out: StructuralChange[],
): void {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    walk(joinIndexPath(path, index), before[index], after[index], depth + 1, out);
  }
}

function diffArrays(
  path: string,
  before: readonly unknown[],
  after: readonly unknown[],
  depth: number,
  out: StructuralChange[],
): void {
  if (isPrimitiveArray(before) && isPrimitiveArray(after)) {
    diffPrimitiveArrayAsSet(path, before, after, out);
    return;
  }
  const identityKey = findSharedIdentityKey(before, after);
  if (identityKey !== null) {
    diffObjectArrayByIdentity(path, identityKey, before, after, depth, out);
    return;
  }
  diffArrayByIndex(path, before, after, depth, out);
}

function diffObjects(
  path: string,
  before: JsonObject,
  after: JsonObject,
  depth: number,
  out: StructuralChange[],
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    walk(joinObjectPath(path, key), before[key], after[key], depth + 1, out);
  }
}

function walk(
  path: string,
  before: unknown,
  after: unknown,
  depth: number,
  out: StructuralChange[],
): void {
  if (before === undefined && after === undefined) {
    return;
  }
  if (before === undefined) {
    out.push(change("added", path, undefined, after));
    return;
  }
  if (after === undefined) {
    out.push(change("removed", path, before, undefined));
    return;
  }
  const beforeType = jsonTypeOf(before);
  const afterType = jsonTypeOf(after);
  if (beforeType !== afterType) {
    out.push(change("type_changed", path, before, after));
    return;
  }
  if (depth >= MAX_DIFF_DEPTH) {
    if (canonicalJson(before) !== canonicalJson(after)) {
      out.push(change("value_changed", path, before, after));
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(path, before, after, depth, out);
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    diffObjects(path, before, after, depth, out);
    return;
  }
  if (before !== after) {
    out.push(change("value_changed", path, before, after));
  }
}

export function diffJson(before: unknown, after: unknown): StructuralChange[] {
  const changes: StructuralChange[] = [];
  walk("", before, after, 0, changes);
  return changes.map((entry) =>
    entry.path === "" ? { ...entry, path: ROOT_PATH_LABEL } : entry,
  );
}

export function countStructuralChanges(
  changes: readonly StructuralChange[],
): StructuralChangeCounts {
  const counts: StructuralChangeCounts = {
    added: 0,
    removed: 0,
    type_changed: 0,
    value_changed: 0,
    reordered: 0,
  };
  for (const entry of changes) {
    counts[entry.kind] += 1;
  }
  return counts;
}
