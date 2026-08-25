import { randomBytes } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_BYTES = 6;
const BYTE_RANGE = 256;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function newId(timestampMs: number = Date.now()): string {
  const bytes = new Uint8Array(randomBytes(16));
  let remaining = timestampMs;
  for (let index = TIMESTAMP_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = remaining % BYTE_RANGE;
    remaining = Math.floor(remaining / BYTE_RANGE);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function newRequestId(): string {
  return newId();
}
