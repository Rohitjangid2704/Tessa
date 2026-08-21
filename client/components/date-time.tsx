import { cn } from "@/lib/utils";

const localFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function parseTimestamp(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateTime(value: string | null | undefined): string | null {
  const parsed = parseTimestamp(value);
  return parsed === null ? null : localFormatter.format(parsed);
}

export function formatUtc(value: string | null | undefined): string | null {
  const parsed = parseTimestamp(value);
  return parsed === null ? null : `${parsed.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export type DateTimeProps = {
  value: string | null | undefined;
  fallback?: string;
  className?: string;
};

export function DateTime({ value, fallback = "Never", className }: DateTimeProps) {
  const parsed = parseTimestamp(value);
  if (parsed === null) {
    return <span className={cn("text-muted-foreground", className)}>{fallback}</span>;
  }
  return (
    <time
      dateTime={parsed.toISOString()}
      title={formatUtc(value) ?? undefined}
      suppressHydrationWarning
      className={className}
    >
      {formatDateTime(value)}
    </time>
  );
}
