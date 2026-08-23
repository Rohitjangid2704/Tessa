import { useCallback, useRef } from "react";
import { createIdempotencyKey } from "@/lib/api/idempotency";

export interface AttemptKeys {
  keyFor: (fingerprint: string) => string;
  settle: () => void;
}

export function useAttemptKeys(): AttemptKeys {
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const keyFor = useCallback((fingerprint: string) => {
    if (attempt.current === null || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: createIdempotencyKey() };
    }
    return attempt.current.key;
  }, []);

  const settle = useCallback(() => {
    attempt.current = null;
  }, []);

  return { keyFor, settle };
}

export function fileFingerprint(file: File, targetId: string, note: string): string {
  return [targetId, file.name, file.size, file.lastModified, note.trim()].join("|");
}

export function textFingerprint(text: string, targetId: string, note: string): string {
  return [targetId, text.length, text, note.trim()].join("|");
}
