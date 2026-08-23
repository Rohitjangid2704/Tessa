import { cn } from "@/lib/utils";

const WIDTH = 120;
const HEIGHT = 32;
const PADDING = 3;
const DOT_RADIUS = 2.5;

type Point = { x: number; y: number };

export function toSparklinePoints(values: readonly number[]): Point[] {
  if (values.length === 0) {
    return [];
  }
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const innerWidth = WIDTH - PADDING * 2;
  const innerHeight = HEIGHT - PADDING * 2;
  return values.map((value, index) => ({
    x: values.length === 1 ? WIDTH / 2 : PADDING + (index / (values.length - 1)) * innerWidth,
    y: span === 0 ? HEIGHT / 2 : HEIGHT - PADDING - ((value - min) / span) * innerHeight,
  }));
}

export type SparklineProps = {
  values: readonly number[];
  label: string;
  className?: string;
};

export function Sparkline({ values, label, className }: SparklineProps) {
  const points = toSparklinePoints(values);
  const last = points.at(-1);
  return (
    <svg
      role="img"
      aria-label={label}
      data-slot="sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={cn("h-8 w-full max-w-40 text-chart-1", className)}
    >
      {points.length > 1 ? (
        <polyline
          points={points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {last === undefined ? null : (
        <circle cx={last.x} cy={last.y} r={DOT_RADIUS} fill="currentColor" />
      )}
    </svg>
  );
}
