import { createHash } from "node:crypto";

const ID_PREFIX_BYTES = [0x01, 0x98, 0xf6, 0xf2, 0x4c, 0x2a];
const PART_SEPARATOR = "\u0000";
const UUID_VERSION_SEVEN = 0x70;
const UUID_VARIANT = 0x80;

export type IdPart = string | number;

export function stableId(namespace: string, ...parts: readonly IdPart[]): string {
  const digest = createHash("sha256")
    .update([namespace, ...parts.map(String)].join(PART_SEPARATOR))
    .digest();
  const bytes = new Uint8Array(16);
  bytes.set(ID_PREFIX_BYTES, 0);
  bytes.set(digest.subarray(0, 10), ID_PREFIX_BYTES.length);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | UUID_VERSION_SEVEN;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | UUID_VARIANT;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function stableUnit(...parts: readonly IdPart[]): number {
  const digest = createHash("sha256").update(parts.map(String).join(PART_SEPARATOR)).digest();
  return digest.readUInt32BE(0) / 4_294_967_296;
}

export function stableInt(minInclusive: number, maxInclusive: number, ...parts: IdPart[]): number {
  return minInclusive + Math.floor(stableUnit(...parts) * (maxInclusive - minInclusive + 1));
}

export function stableHex(length: number, ...parts: readonly IdPart[]): string {
  return createHash("sha256")
    .update(parts.map(String).join(PART_SEPARATOR))
    .digest("hex")
    .slice(0, length);
}
