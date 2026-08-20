export type DiffLineKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  originalLine: number | null;
  modifiedLine: number | null;
}

const MAX_TABLE_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

function lengthTable(original: readonly string[], modified: readonly string[]): Uint32Array {
  const width = modified.length + 1;
  const table = new Uint32Array((original.length + 1) * width);
  for (let row = original.length - 1; row >= 0; row -= 1) {
    for (let column = modified.length - 1; column >= 0; column -= 1) {
      const index = row * width + column;
      table[index] =
        original[row] === modified[column]
          ? (table[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(table[(row + 1) * width + column] ?? 0, table[row * width + column + 1] ?? 0);
    }
  }
  return table;
}

function replaceAll(original: readonly string[], modified: readonly string[]): DiffLine[] {
  return [
    ...original.map(
      (text, index): DiffLine => ({
        kind: "removed",
        text,
        originalLine: index + 1,
        modifiedLine: null,
      }),
    ),
    ...modified.map(
      (text, index): DiffLine => ({
        kind: "added",
        text,
        originalLine: null,
        modifiedLine: index + 1,
      }),
    ),
  ];
}

export function diffLines(originalText: string, modifiedText: string): DiffLine[] {
  const original = splitLines(originalText);
  const modified = splitLines(modifiedText);
  if ((original.length + 1) * (modified.length + 1) > MAX_TABLE_CELLS) {
    return replaceAll(original, modified);
  }
  const table = lengthTable(original, modified);
  const width = modified.length + 1;
  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < original.length && column < modified.length) {
    const currentOriginal = original[row] ?? "";
    if (currentOriginal === modified[column]) {
      lines.push({
        kind: "same",
        text: currentOriginal,
        originalLine: row + 1,
        modifiedLine: column + 1,
      });
      row += 1;
      column += 1;
    } else if ((table[(row + 1) * width + column] ?? 0) >= (table[row * width + column + 1] ?? 0)) {
      lines.push({
        kind: "removed",
        text: currentOriginal,
        originalLine: row + 1,
        modifiedLine: null,
      });
      row += 1;
    } else {
      lines.push({
        kind: "added",
        text: modified[column] ?? "",
        originalLine: null,
        modifiedLine: column + 1,
      });
      column += 1;
    }
  }
  while (row < original.length) {
    lines.push({
      kind: "removed",
      text: original[row] ?? "",
      originalLine: row + 1,
      modifiedLine: null,
    });
    row += 1;
  }
  while (column < modified.length) {
    lines.push({
      kind: "added",
      text: modified[column] ?? "",
      originalLine: null,
      modifiedLine: column + 1,
    });
    column += 1;
  }
  return lines;
}

export function countChanges(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") {
      added += 1;
    } else if (line.kind === "removed") {
      removed += 1;
    }
  }
  return { added, removed };
}
