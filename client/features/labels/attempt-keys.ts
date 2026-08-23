import { createIdempotencyKey } from "@/lib/api/idempotency";
import type { LabelCreate } from "@/lib/api/types";

export function labelFingerprint(label: LabelCreate): string {
  return [label.subject_type, label.subject_id, label.value, label.note ?? ""].join("|");
}

export class AttemptKeyRing {
  private readonly keys = new Map<string, string>();

  keyFor(fingerprint: string): string {
    const existing = this.keys.get(fingerprint);
    if (existing !== undefined) {
      return existing;
    }
    const created = createIdempotencyKey();
    this.keys.set(fingerprint, created);
    return created;
  }

  settle(fingerprint: string): void {
    this.keys.delete(fingerprint);
  }
}
