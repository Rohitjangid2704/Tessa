import { cn } from "@/lib/utils";

export interface ScoreGaugeProps {
  score: number;
  bar: number;
  label: string;
  max?: number;
  className?: string;
}

function percent(value: number, max: number): number {
  if (max <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export function ScoreGauge({ score, bar, label, max = 100, className }: ScoreGaugeProps) {
  const meetsBar = score >= bar;
  const statusText = meetsBar ? "meets the bar" : "below the bar";

  return (
    <div data-slot="score-gauge" className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums">{score}</span>
        <span className="text-sm text-muted-foreground">of {max}</span>
      </div>
      <div className="relative pt-5">
        <span
          aria-hidden="true"
          className="absolute top-0 -translate-x-1/2 text-xs font-medium whitespace-nowrap"
          style={{ left: `${percent(bar, max)}%` }}
        >
          Bar {bar}
        </span>
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={score}
          aria-valuetext={`${score} of ${max}, bar ${bar}, ${statusText}`}
          className="relative h-3 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            data-slot="score-gauge-fill"
            className={cn(
              "h-full rounded-full",
              meetsBar ? "bg-verdict-pass-fg" : "bg-verdict-flaky-fg",
            )}
            style={{ width: `${percent(score, max)}%` }}
          />
        </div>
        <span
          aria-hidden="true"
          data-slot="score-gauge-marker"
          className="absolute bottom-[-4px] h-5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${percent(bar, max)}%` }}
        />
      </div>
    </div>
  );
}
