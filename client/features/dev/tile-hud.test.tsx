import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createInitialFrameBusStats, type FrameBusStats } from "@/lib/ws/frame-bus";
import type { PerformanceSnapshot } from "./performance-monitor";
import { HUD_PASS_LINE, TileHud, buildHudMetrics, evaluateHud } from "./tile-hud";

function performanceSnapshot(overrides: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
  return {
    elapsedMs: 120_000,
    longTaskCount: 0,
    longTasksPerMinute: 0,
    longestTaskMs: 0,
    heapSupported: true,
    heapUsedMb: 50,
    heapBaselineMb: 45,
    heapGrowthMb: 5,
    heapPeakMb: 60,
    ...overrides,
  };
}

function busStats(overrides: Partial<FrameBusStats> = {}): FrameBusStats {
  return { ...createInitialFrameBusStats(), ...overrides };
}

describe("evaluateHud", () => {
  it("passes inside the line", () => {
    expect(
      evaluateHud(busStats({ handlerP95Ms: 4.9 }), performanceSnapshot({ longTasksPerMinute: 2 })),
    ).toEqual({ longTasks: true, handler: true, heap: true });
  });

  it("fails each metric over its line", () => {
    expect(
      evaluateHud(
        busStats({ handlerP95Ms: 5 }),
        performanceSnapshot({ longTasksPerMinute: 2.1, heapGrowthMb: 30 }),
      ),
    ).toEqual({ longTasks: false, handler: false, heap: false });
  });

  it("does not judge the heap where it cannot be read", () => {
    expect(evaluateHud(busStats(), performanceSnapshot({ heapSupported: false })).heap).toBeNull();
  });

  it("keeps the pass line of the plan", () => {
    expect(HUD_PASS_LINE).toEqual({ longTasksPerMinute: 2, handlerP95Ms: 5, heapGrowthMb: 30 });
  });
});

describe("TileHud", () => {
  it("shows received, painted, dropped, p95 decode, long tasks and the heap", () => {
    render(
      <TileHud
        bus={busStats({ received: 480, painted: 300, dropped: 180, decodeP95Ms: 3.2 })}
        performance={performanceSnapshot({
          longTaskCount: 1,
          longTasksPerMinute: 0.5,
          heapUsedMb: 52.4,
          heapGrowthMb: 7.4,
        })}
      />,
    );

    const hud = screen.getByTestId("tile-hud");
    const value = (key: string) =>
      within(hud.querySelector(`[data-metric="${key}"]`) as HTMLElement).getByText(/./, {
        selector: "[data-value]",
      }).textContent;
    expect(value("received")).toBe("480");
    expect(value("painted")).toBe("300");
    expect(value("dropped")).toBe("180");
    expect(value("decode-p95")).toBe("3.2 ms");
    expect(value("long-tasks")).toContain("1 (0.5 per min)");
    expect(value("heap")).toContain("52.4 MB (+7.4 MB)");
  });

  it("exposes a machine readable snapshot for the measurement script", () => {
    render(<TileHud bus={busStats({ received: 12 })} performance={performanceSnapshot()} />);

    const snapshot = JSON.parse(
      screen.getByTestId("tile-hud").getAttribute("data-snapshot") ?? "{}",
    ) as { bus: FrameBusStats; performance: PerformanceSnapshot };
    expect(snapshot.bus.received).toBe(12);
    expect(snapshot.performance.heapGrowthMb).toBe(5);
  });

  it("marks metrics over their line in words, not only colour", () => {
    render(
      <TileHud
        bus={busStats({ handlerP95Ms: 9 })}
        performance={performanceSnapshot({ longTasksPerMinute: 1 })}
      />,
    );

    const handler = screen.getByTestId("tile-hud").querySelector('[data-metric="handler-p95"]');
    const longTasks = screen.getByTestId("tile-hud").querySelector('[data-metric="long-tasks"]');
    expect(handler).toHaveTextContent("over");
    expect(longTasks).toHaveTextContent("within");
  });

  it("builds one metric per key without duplicates", () => {
    const keys = buildHudMetrics(busStats(), performanceSnapshot()).map((metric) => metric.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports an unreadable heap", () => {
    render(
      <TileHud bus={busStats()} performance={performanceSnapshot({ heapSupported: false })} />,
    );

    expect(screen.getByTestId("tile-hud").querySelector('[data-metric="heap"]')).toHaveTextContent(
      "not available",
    );
  });
});
