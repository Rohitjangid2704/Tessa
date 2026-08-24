"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatUtc } from "@/components/date-time";
import { isTrendDatum, type TrendDatum } from "./trend-data";

export const TREND_CHART_HEIGHT_PX = 200;

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export type TrendChartCanvasProps = {
  data: readonly TrendDatum[];
  label: string;
  color: string;
  fractional: boolean;
  formatValue: (value: number) => string;
  onSelectRun: (runId: string) => void;
};

interface DotRenderProps {
  cx?: number;
  cy?: number;
  payload?: unknown;
}

export function TrendChartCanvas({
  data,
  label,
  color,
  fractional,
  formatValue,
  onSelectRun,
}: TrendChartCanvasProps) {
  function renderDot(props: DotRenderProps) {
    const { cx, cy, payload } = props;
    if (cx === undefined || cy === undefined || !isTrendDatum(payload)) {
      return <g />;
    }
    const { runId } = payload;
    return (
      <circle
        cx={cx}
        cy={cy}
        r={4}
        fill={color}
        stroke="var(--card)"
        strokeWidth={2}
        data-run-id={runId ?? undefined}
        style={{ cursor: runId === null ? "default" : "pointer" }}
        onClick={() => {
          if (runId !== null) {
            onSelectRun(runId);
          }
        }}
      />
    );
  }

  return (
    <ResponsiveContainer width="100%" height={TREND_CHART_HEIGHT_PX}>
      <LineChart
        data={[...data]}
        margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
        accessibilityLayer={false}
      >
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="time"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(time: number) => shortDateFormatter.format(new Date(time))}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          stroke="var(--border)"
          tickMargin={6}
        />
        <YAxis
          width={56}
          domain={fractional ? [0, 1] : [0, "auto"]}
          tickFormatter={(value: number) => formatValue(value)}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          stroke="var(--border)"
        />
        <Tooltip
          formatter={(value: unknown) => formatValue(Number(value))}
          labelFormatter={(time: unknown) => formatUtc(new Date(Number(time)).toISOString()) ?? ""}
          contentStyle={{
            background: "var(--popover)",
            color: "var(--popover-foreground)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="value"
          name={label}
          stroke={color}
          strokeWidth={2}
          dot={renderDot}
          activeDot={renderDot}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
