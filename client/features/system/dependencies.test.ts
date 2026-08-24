import { describe, expect, it } from "vitest";
import { downDependencyLabels, formatLatency, toDependencyRows } from "./dependencies";
import { schemaFileName, shortSha } from "./schemas";

const healthy = {
  db: { status: "up", latency_ms: 3, detail: null },
  temporal: { status: "up", latency_ms: 5, detail: null },
  laya: { status: "up", latency_ms: 12, detail: "HTTP 200" },
  storage: { status: "unconfigured", latency_ms: null, detail: "defined in Phase 1" },
} as const;

describe("toDependencyRows", () => {
  it("returns db, temporal, laya and storage in that order with readable labels", () => {
    const rows = toDependencyRows(healthy);

    expect(rows.map((row) => [row.key, row.label])).toEqual([
      ["db", "Database"],
      ["temporal", "Temporal"],
      ["laya", "Laya"],
      ["storage", "Storage"],
    ]);
    expect(rows[2]).toMatchObject({ status: "up", latencyMs: 12, detail: "HTTP 200" });
    expect(rows[3]).toMatchObject({ status: "unconfigured", latencyMs: null });
  });
});

describe("downDependencyLabels", () => {
  it("lists only the dependencies that are down", () => {
    const rows = toDependencyRows({
      ...healthy,
      temporal: { status: "down", latency_ms: null, detail: "RuntimeError" },
      laya: { status: "down", latency_ms: null, detail: "ConnectError" },
    });

    expect(downDependencyLabels(rows)).toEqual(["Temporal", "Laya"]);
  });

  it("does not count unconfigured as down", () => {
    expect(downDependencyLabels(toDependencyRows(healthy))).toEqual([]);
  });
});

describe("formatLatency", () => {
  it("formats milliseconds and a missing value", () => {
    expect(formatLatency(12)).toBe("12 ms");
    expect(formatLatency(0)).toBe("0 ms");
    expect(formatLatency(null)).toBe("n/a");
  });
});

describe("schema helpers", () => {
  it("builds the published file name and shortens the hash", () => {
    expect(schemaFileName({ name: "bundle", version: 1 })).toBe("bundle.v1.json");
    expect(schemaFileName({ name: "stream-event", version: 2 })).toBe("stream-event.v2.json");
    expect(shortSha("0123456789abcdef0123456789abcdef")).toBe("0123456789ab");
  });
});
