import { TriangleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import type { ProbeStatus } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { clampUnit, formatUnit, PROBE_STATUS_LABELS } from "../probe-model";

export type ConfidenceBarProps = {
  value: number;
  threshold: number;
  status: ProbeStatus;
  label?: string;
} & Omit<ComponentProps<"div">, "children">;

const STRIPES =
  "[background-image:repeating-linear-gradient(135deg,transparent_0_4px,var(--background)_4px_6px)]";

const FILL_CLASSES: Record<ProbeStatus, string> = {
  decided: "bg-tier-laya-fg",
  uncertain: `bg-verdict-uncertain-fg ${STRIPES}`,
  error: `bg-severity-high-fg ${STRIPES}`,
};

function toPercent(unit: number): number {
  return Math.round(unit * 10000) / 100;
}

function RangeFlag({ subject, reported }: { subject: string; reported: number }) {
  return (
    <span data-slot="out-of-range" className="inline-flex items-center gap-1">
      <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />
      {subject} reported as {formatUnit(reported)}, outside 0 to 1, shown clamped
    </span>
  );
}

export function ConfidenceBar({
  value,
  threshold,
  status,
  label = "Confidence",
  className,
  ...props
}: ConfidenceBarProps) {
  const confidence = clampUnit(value);
  const limit = clampUnit(threshold);
  const outOfRange = confidence.clamped || limit.clamped;
  const belowThreshold = confidence.value < limit.value;
  const valueText = `${formatUnit(confidence.value)} of 1, ${PROBE_STATUS_LABELS[status].toLowerCase()}, threshold ${formatUnit(limit.value)}`;

  return (
    <div
      data-slot="confidence-bar"
      data-status={status}
      data-clamped={outOfRange}
      className={cn("flex flex-col gap-1", className)}
      {...props}
    >
      <div className="flex items-center gap-3">
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={confidence.value}
          aria-valuetext={valueText}
          data-slot="confidence-meter"
          className="relative h-2.5 min-w-24 flex-1 rounded-full bg-muted"
        >
          <div
            data-slot="confidence-fill"
            className={cn("absolute inset-y-0 left-0 rounded-full", FILL_CLASSES[status])}
            style={{ width: `${toPercent(confidence.value)}%` }}
          />
          <div
            aria-hidden="true"
            data-slot="threshold-tick"
            className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground ring-1 ring-background"
            style={{ left: `${toPercent(limit.value)}%` }}
          />
        </div>
        <span data-slot="confidence-number" className="text-sm font-medium tabular-nums">
          {formatUnit(confidence.value)}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        <span data-slot="threshold-number">Threshold {formatUnit(limit.value)}</span>
        {belowThreshold ? <span data-slot="below-threshold">Below the threshold</span> : null}
        {confidence.clamped ? (
          <RangeFlag subject="Confidence" reported={confidence.reported} />
        ) : null}
        {limit.clamped ? <RangeFlag subject="Threshold" reported={limit.reported} /> : null}
      </p>
    </div>
  );
}
