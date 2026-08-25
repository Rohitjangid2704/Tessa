export function secretKey(secret: string): Uint8Array {
  return Uint8Array.from(Buffer.from(secret));
}
