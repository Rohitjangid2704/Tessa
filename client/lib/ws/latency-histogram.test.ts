import { describe, expect, it } from "vitest";
import { LatencyHistogram } from "./latency-histogram";

describe("LatencyHistogram", () => {
  it("reports zero for an empty histogram", () => {
    const histogram = new LatencyHistogram();
    expect(histogram.count).toBe(0);
    expect(histogram.percentile(0.95)).toBe(0);
    expect(histogram.max).toBe(0);
  });

  it("computes percentiles within one bucket of the true value", () => {
    const histogram = new LatencyHistogram();
    for (let value = 1; value <= 100; value += 1) {
      histogram.record(value / 10);
    }

    expect(histogram.count).toBe(100);
    expect(histogram.percentile(0.5)).toBeGreaterThanOrEqual(5);
    expect(histogram.percentile(0.5)).toBeLessThanOrEqual(5.2);
    expect(histogram.percentile(0.95)).toBeGreaterThanOrEqual(9.5);
    expect(histogram.percentile(0.95)).toBeLessThanOrEqual(9.7);
    expect(histogram.max).toBe(10);
  });

  it("never reports a percentile above the largest value seen", () => {
    const histogram = new LatencyHistogram();
    histogram.record(0.31);

    expect(histogram.percentile(0.99)).toBeLessThanOrEqual(0.31);
  });

  it("clamps values beyond the range into the last bucket and keeps the true max", () => {
    const histogram = new LatencyHistogram(1, 10);
    histogram.record(500);
    histogram.record(1);

    expect(histogram.max).toBe(500);
    expect(histogram.percentile(1)).toBe(500);
    expect(histogram.count).toBe(2);
  });

  it("treats negative, NaN and infinite values as zero", () => {
    const histogram = new LatencyHistogram();
    histogram.record(-4);
    histogram.record(Number.NaN);
    histogram.record(Number.POSITIVE_INFINITY);

    expect(histogram.count).toBe(3);
    expect(histogram.max).toBe(0);
  });

  it("separates a tail from the median", () => {
    const histogram = new LatencyHistogram();
    for (let index = 0; index < 94; index += 1) {
      histogram.record(1);
    }
    for (let index = 0; index < 6; index += 1) {
      histogram.record(40);
    }

    expect(histogram.percentile(0.5)).toBeLessThan(1.2);
    expect(histogram.percentile(0.95)).toBeGreaterThan(39);
  });

  it("resets", () => {
    const histogram = new LatencyHistogram();
    histogram.record(3);
    histogram.reset();

    expect(histogram.count).toBe(0);
    expect(histogram.max).toBe(0);
    expect(histogram.percentile(0.95)).toBe(0);
  });
});
