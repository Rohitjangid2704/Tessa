const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_./${}-]*$/;
const RESERVED_WORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);
const INDENT = "  ";

function scalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text = String(value);
  return PLAIN_SCALAR.test(text) && !RESERVED_WORDS.has(text) ? text : JSON.stringify(text);
}

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isContainer(value) && Object.keys(value).length === 0;
}

function emptyLiteral(value: unknown): string {
  return Array.isArray(value) ? "[]" : "{}";
}

function renderArray(items: readonly unknown[], depth: number): string[] {
  const pad = INDENT.repeat(depth);
  return items.flatMap((item) => {
    if (!isContainer(item) || isEmptyContainer(item)) {
      return [`${pad}- ${isContainer(item) ? emptyLiteral(item) : scalar(item)}`];
    }
    const [first = "", ...rest] = renderValue(item, depth + 1);
    return [`${pad}- ${first.trimStart()}`, ...rest];
  });
}

function renderObject(value: object, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  return Object.entries(value).flatMap(([key, child]) => {
    if (!isContainer(child)) {
      return [`${pad}${key}: ${scalar(child)}`];
    }
    if (isEmptyContainer(child)) {
      return [`${pad}${key}: ${emptyLiteral(child)}`];
    }
    return [`${pad}${key}:`, ...renderValue(child, depth + 1)];
  });
}

function renderValue(value: object, depth: number): string[] {
  return Array.isArray(value) ? renderArray(value, depth) : renderObject(value, depth);
}

export function toYaml(value: object): string {
  return `${renderValue(value, 0).join("\n")}\n`;
}
