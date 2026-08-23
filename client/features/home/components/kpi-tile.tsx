"use client";

import { CircleCheck, CircleX, Minus, TriangleAlert, type LucideIcon } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { readRequestId } from "@/components/states/request-id";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import type { KpiTone } from "../mutation-headline";

const TONE_PRESENTATION = {
  good: { tone: "kpi-good", label: "On track", icon: CircleCheck },
  warn: { tone: "kpi-warn", label: "Needs attention", icon: TriangleAlert },
  bad: { tone: "kpi-bad", label: "Action needed", icon: CircleX },
  neutral: { tone: "hollow", label: "No signal", icon: Minus },
} as const;

export type KpiTileLoadState = {
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
};

export type KpiTileProps = Omit<ComponentProps<"section">, "title" | "children"> & {
  title: string;
  icon?: LucideIcon;
  tone?: KpiTone;
  statusLabel?: string;
  load?: KpiTileLoadState;
  footer?: ReactNode;
  children: ReactNode;
};

function hasError(error: unknown): boolean {
  return error !== null && error !== undefined;
}

export function KpiStatus({ tone, label }: { tone: KpiTone; label?: string }) {
  const presentation = TONE_PRESENTATION[tone];
  return (
    <StatusBadge
      data-slot="kpi-status"
      data-tone={tone}
      tone={presentation.tone}
      icon={presentation.icon}
      label={label ?? presentation.label}
    />
  );
}

export function KpiValue({ value, detail }: { value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p data-slot="kpi-value" className="text-3xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {detail === undefined ? null : <p className="text-sm text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function KpiLoading({ title }: { title: string }) {
  return (
    <div role="status" aria-busy="true" data-slot="kpi-loading" className="flex flex-col gap-2">
      <span className="sr-only">Loading {title}</span>
      <Skeleton className="h-9 w-28" />
      <Skeleton className="h-4 w-40 max-w-full" />
    </div>
  );
}

export type KpiErrorProps = {
  title: string;
  error: unknown;
  onRetry: () => void;
};

export function KpiError({ title, error, onRetry }: KpiErrorProps) {
  const requestId = readRequestId(error);
  return (
    <div role="alert" data-slot="kpi-error" className="flex flex-col items-start gap-2 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-destructive">
        <TriangleAlert aria-hidden="true" className="size-4" />
        Could not load {title.toLowerCase()}
      </p>
      <p className="text-muted-foreground">{describeApiError(error)}</p>
      {requestId === null ? null : (
        <p className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function KpiTile({
  title,
  icon: Icon,
  tone = "neutral",
  statusLabel,
  load,
  footer,
  className,
  children,
  ...props
}: KpiTileProps) {
  const headingId = useId();
  const settled = load === undefined || (!load.isPending && !hasError(load.error));

  function renderBody(): ReactNode {
    if (load === undefined) {
      return children;
    }
    if (load.isPending) {
      return <KpiLoading title={title} />;
    }
    if (hasError(load.error)) {
      return <KpiError title={title} error={load.error} onRetry={load.onRetry} />;
    }
    return children;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="kpi-tile"
      data-tone={settled ? tone : "neutral"}
      className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4", className)}
      {...props}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          id={headingId}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
        >
          {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4" />}
          {title}
        </h3>
        {settled && tone !== "neutral" ? <KpiStatus tone={tone} label={statusLabel} /> : null}
      </div>
      {renderBody()}
      {settled && footer !== undefined ? <div className="mt-auto text-sm">{footer}</div> : null}
    </section>
  );
}
