"use client";

import type { FrameBusStats } from "@/lib/ws/frame-bus";
import type { PerformanceSnapshot } from "./performance-monitor";

export const HUD_PASS_LINE = {
  longTasksPerMinute: 2,
  handlerP95Ms: 5,
  heapGrowthMb: 30,
} as const;

export interface HudVerdict {
  longTasks: boolean;
  handler: boolean;
  heap: boolean | null;
}

export function evaluateHud(bus: FrameBusStats, performance: PerformanceSnapshot): HudVerdict {
  return {
    longTasks: performance.longTasksPerMinute <= HUD_PASS_LINE.longTasksPerMinute,
    handler: bus.handlerP95Ms < HUD_PASS_LINE.handlerP95Ms,
    heap: performance.heapSupported ? performance.heapGrowthMb < HUD_PASS_LINE.heapGrowthMb : null,
  };
}

interface Metric {
  key: string;
  label: string;
  value: string;
  verdict?: boolean | null;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function formatSeconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)} s`;
}

export function buildHudMetrics(bus: FrameBusStats, performance: PerformanceSnapshot): Metric[] {
  const verdict = evaluateHud(bus, performance);
  return [
    { key: "received", label: "Received", value: String(bus.received) },
    { key: "painted", label: "Painted", value: String(bus.painted) },
    { key: "dropped", label: "Dropped", value: String(bus.dropped) },
    { key: "decode-errors", label: "Decode errors", value: String(bus.decodeErrors) },
    { key: "decode-p95", label: "Decode p95", value: formatMs(bus.decodeP95Ms) },
    {
      key: "handler-p95",
      label: "Handler p95",
      value: formatMs(bus.handlerP95Ms),
      verdict: verdict.handler,
    },
    { key: "handler-max", label: "Handler max", value: formatMs(bus.handlerMaxMs) },
    { key: "paint-p95", label: "Paint p95", value: formatMs(bus.paintP95Ms) },
    {
      key: "long-tasks",
      label: "Long tasks (over 50 ms)",
      value: `${performance.longTaskCount} (${performance.longTasksPerMinute.toFixed(1)} per min)`,
      verdict: verdict.longTasks,
    },
    { key: "longest-task", label: "Longest task", value: formatMs(performance.longestTaskMs) },
    {
      key: "heap",
      label: "JS heap",
      value: performance.heapSupported
        ? `${performance.heapUsedMb.toFixed(1)} MB (${performance.heapGrowthMb >= 0 ? "+" : ""}${performance.heapGrowthMb.toFixed(1)} MB)`
        : "not available",
      verdict: verdict.heap,
    },
    { key: "heap-peak", label: "Heap peak", value: `${performance.heapPeakMb.toFixed(1)} MB` },
    { key: "acks", label: "Acks sent", value: String(bus.acksSent) },
    { key: "subscribes", label: "Subscribes sent", value: String(bus.subscribesSent) },
    {
      key: "tiles",
      label: "Tiles subscribed / visible",
      value: `${bus.subscribedTiles} / ${bus.visibleTiles}`,
    },
    {
      key: "received-mb",
      label: "Received",
      value: `${(bus.bytesReceived / (1024 * 1024)).toFixed(1)} MB`,
    },
    { key: "elapsed", label: "Elapsed", value: formatSeconds(performance.elapsedMs) },
    { key: "page", label: "Page", value: bus.pageVisible ? "visible" : "hidden" },
  ];
}

function VerdictMark({ verdict }: { verdict: boolean | null | undefined }) {
  if (verdict === undefined || verdict === null) {
    return null;
  }
  return verdict ? (
    <span className="ml-1 rounded bg-verdict-pass-bg px-1 font-sans text-verdict-pass-fg">
      within
    </span>
  ) : (
    <span className="ml-1 rounded bg-verdict-fail-bg px-1 font-sans text-verdict-fail-fg">
      over
    </span>
  );
}

export function TileHud({
  bus,
  performance,
}: {
  bus: FrameBusStats;
  performance: PerformanceSnapshot;
}) {
  const metrics = buildHudMetrics(bus, performance);
  return (
    <section
      aria-label="Tile pipeline metrics"
      data-testid="tile-hud"
      data-snapshot={JSON.stringify({ bus, performance })}
      className="rounded-lg border bg-card p-3 text-card-foreground"
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-6">
        {metrics.map((metric) => (
          <div key={metric.key} className="flex flex-col" data-metric={metric.key}>
            <dt className="text-muted-foreground">{metric.label}</dt>
            <dd className="font-mono tabular-nums" data-value>
              {metric.value}
              <VerdictMark verdict={metric.verdict} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Pass line over a run: at most {HUD_PASS_LINE.longTasksPerMinute} long tasks per minute,
        handler p95 under {HUD_PASS_LINE.handlerP95Ms} ms, heap growth under{" "}
        {HUD_PASS_LINE.heapGrowthMb} MB.
      </p>
    </section>
  );
}
