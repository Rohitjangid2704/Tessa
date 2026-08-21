import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const PERCENT = 100;

const FILL_CLASSES = {
  pass: "bg-verdict-pass-fg",
  neutral: "bg-foreground/60",
  warn: "bg-kpi-warn-fg",
  bad: "bg-kpi-bad-fg",
} as const;

export type MeterTone = keyof typeof FILL_CLASSES;

export type MeterProps = Omit<ComponentProps<"div">, "children"> & {
  value: number | null;
  label: string;
  valueText?: string;
  tone?: MeterTone;
};

export function toMeterPercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.min(1, Math.max(0, value)) * PERCENT);
}

export function Meter({ value, label, valueText, tone = "pass", className, ...props }: MeterProps) {
  const percent = toMeterPercent(value);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={PERCENT}
      aria-valuenow={percent}
      aria-valuetext={valueText ?? (value === null ? "No data" : `${percent}%`)}
      data-slot="meter"
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div
        data-slot="meter-fill"
        className={cn(
          "h-full rounded-full transition-[width] motion-reduce:transition-none",
          FILL_CLASSES[tone],
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
