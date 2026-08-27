export const MAX_RESULT_BYTES = 60_000;
export const PAYLOAD_CUT_BYTES = 20_000;

export type Cut = {
  value: unknown;
  truncated: boolean;
};

function cutText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) {
    return text;
  }
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return text.slice(0, end);
}

export function cutValue(value: unknown, maxBytes: number = PAYLOAD_CUT_BYTES): Cut {
  if (value === null || value === undefined) {
    return { value: null, truncated: false };
  }
  if (typeof value === "string") {
    const text = cutText(value, maxBytes);
    return { value: text, truncated: text.length < value.length };
  }
  const serialised = JSON.stringify(value);
  if (Buffer.byteLength(serialised) <= maxBytes) {
    return { value, truncated: false };
  }
  return { value: cutText(serialised, maxBytes), truncated: true };
}

export function cutList<Item>(items: readonly Item[], maxItems: number): { items: Item[]; total: number; truncated: boolean } {
  return {
    items: items.slice(0, maxItems),
    total: items.length,
    truncated: items.length > maxItems,
  };
}

export const RESULT_BUDGET_BYTES = 55_000;
const MINIMUM_CUT_BYTES = 1000;

function sizeOf(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
}

export function fitCutBytes(payloads: readonly unknown[], baseBytes: number): number {
  const sizes = payloads.map(sizeOf);
  let limit = PAYLOAD_CUT_BYTES;
  while (limit > MINIMUM_CUT_BYTES) {
    const total = sizes.reduce((sum, size) => sum + Math.min(size, limit), 0);
    if (baseBytes + total <= RESULT_BUDGET_BYTES) {
      return limit;
    }
    limit = Math.floor(limit * 0.8);
  }
  return MINIMUM_CUT_BYTES;
}
