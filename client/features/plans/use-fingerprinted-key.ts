import { useState } from "react";
import { createIdempotencyKey } from "@/lib/api/idempotency";

interface StoredKey {
  fingerprint: string;
  key: string;
}

export function useFingerprintedKey() {
  const [stored, setStored] = useState<StoredKey | null>(null);

  function keyFor(body: unknown): string {
    const fingerprint = JSON.stringify(body);
    if (stored !== null && stored.fingerprint === fingerprint) {
      return stored.key;
    }
    const key = createIdempotencyKey();
    setStored({ fingerprint, key });
    return key;
  }

  function forget(): void {
    setStored(null);
  }

  return { keyFor, forget } as const;
}
