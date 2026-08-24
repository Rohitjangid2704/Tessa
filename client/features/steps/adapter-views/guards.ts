export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isListOf<Item>(
  value: unknown,
  isItem: (entry: unknown) => entry is Item,
): value is Item[] {
  return Array.isArray(value) && value.every(isItem);
}

export function hasKind(value: unknown, kind: string): value is UnknownRecord {
  return isRecord(value) && value.kind === kind;
}

export function extraFieldsOf(
  payload: object,
  knownKeys: readonly string[],
): UnknownRecord | null {
  const extras = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !knownKeys.includes(key)),
  );
  return Object.keys(extras).length === 0 ? null : extras;
}
