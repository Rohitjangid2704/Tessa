import { cn } from "@/lib/utils";

export type JsonRecord = Record<string, unknown>;

export interface JsonDiffProps {
  before: JsonRecord | null | undefined;
  after: JsonRecord | null | undefined;
  fields?: readonly string[];
  className?: string;
}

export interface ArrayDelta {
  added: unknown[];
  removed: unknown[];
  reordered: boolean;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function differingFields(before: JsonRecord, after: JsonRecord): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => stableStringify(before[name]) !== stableStringify(after[name]))
    .sort();
}

export function diffArrays(before: readonly unknown[], after: readonly unknown[]): ArrayDelta {
  const beforeKeys = before.map(stableStringify);
  const afterKeys = after.map(stableStringify);
  const afterSet = new Set(afterKeys);
  const beforeSet = new Set(beforeKeys);
  const removed = before.filter((_item, index) => !afterSet.has(beforeKeys[index] ?? ""));
  const added = after.filter((_item, index) => !beforeSet.has(afterKeys[index] ?? ""));
  return {
    added,
    removed,
    reordered:
      added.length === 0 && removed.length === 0 && beforeKeys.join("\n") !== afterKeys.join("\n"),
  };
}

export function formatJsonValue(value: unknown): string {
  if (value === undefined) {
    return "not set";
  }
  if (typeof value === "string") {
    return value === "" ? "empty text" : value;
  }
  return JSON.stringify(value, null, 2) ?? "not set";
}

const REMOVED_CLASSES = "bg-verdict-fail-bg text-verdict-fail-fg";
const ADDED_CLASSES = "bg-verdict-pass-bg text-verdict-pass-fg";

function ValueBlock({
  caption,
  value,
  tone,
}: {
  caption: string;
  value: unknown;
  tone: "removed" | "added";
}) {
  return (
    <div data-side={caption.toLowerCase()} className="flex min-w-0 flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{caption}</p>
      <pre
        className={cn(
          "rounded-md px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap",
          tone === "removed" ? REMOVED_CLASSES : ADDED_CLASSES,
        )}
      >
        {formatJsonValue(value)}
      </pre>
    </div>
  );
}

function ItemList({ items, kind }: { items: readonly unknown[]; kind: "added" | "removed" }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, index) => (
        <li
          key={`${kind}:${index}`}
          data-item={kind}
          className={cn(
            "flex items-start gap-2 rounded-md px-2 py-1.5 font-mono text-xs",
            kind === "added" ? ADDED_CLASSES : REMOVED_CLASSES,
          )}
        >
          <span aria-hidden="true">{kind === "added" ? "+" : "-"}</span>
          <span className="sr-only">{kind === "added" ? "Added:" : "Removed:"}</span>
          <span className="min-w-0 break-words whitespace-pre-wrap">{formatJsonValue(item)}</span>
        </li>
      ))}
    </ul>
  );
}

export function JsonFieldDiff({
  name,
  before,
  after,
}: {
  name: string;
  before: unknown;
  after: unknown;
}) {
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  const delta = bothArrays ? diffArrays(before, after) : null;

  return (
    <section data-field={name} className="flex flex-col gap-2">
      <h4 className="font-mono text-xs font-semibold">{name}</h4>
      {delta === null ? (
        <div className="grid gap-2 md:grid-cols-2">
          <ValueBlock caption="Before" value={before} tone="removed" />
          <ValueBlock caption="After" value={after} tone="added" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <ItemList items={delta.removed} kind="removed" />
          <ItemList items={delta.added} kind="added" />
          {delta.reordered ? (
            <p className="text-xs text-muted-foreground">Same items in a different order.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function JsonDiff({ before, after, fields, className }: JsonDiffProps) {
  const left = before ?? {};
  const right = after ?? {};
  const names = fields === undefined ? differingFields(left, right) : [...fields];

  if (names.length === 0) {
    return <p className="text-sm text-muted-foreground">No field differs.</p>;
  }

  return (
    <div data-slot="json-diff" className={cn("flex flex-col gap-4", className)}>
      {names.map((name) => (
        <JsonFieldDiff key={name} name={name} before={left[name]} after={right[name]} />
      ))}
    </div>
  );
}
