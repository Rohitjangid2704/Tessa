import { useCallback, useState } from "react";

export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function useIdempotencyKey() {
  const [key, setKey] = useState(createIdempotencyKey);
  const rotate = useCallback(() => setKey(createIdempotencyKey()), []);
  return { key, rotate } as const;
}
