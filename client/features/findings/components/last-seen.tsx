"use client";

import { formatDateTime, formatUtc, parseTimestamp } from "@/components/date-time";
import { useNow } from "@/lib/use-now";
import { formatRelativeAge } from "../format";

const REFRESH_MS = 30_000;

export function LastSeen({ value }: { value: string }) {
  const now = useNow(REFRESH_MS);
  const parsed = parseTimestamp(value);
  if (parsed === null) {
    return <span className="text-muted-foreground">unknown</span>;
  }
  const relative = now === null ? null : formatRelativeAge(parsed.getTime(), now);
  return (
    <time
      dateTime={parsed.toISOString()}
      title={formatUtc(value) ?? undefined}
      suppressHydrationWarning
    >
      {relative ?? formatDateTime(value)}
    </time>
  );
}
