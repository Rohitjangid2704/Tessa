import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DateTime, formatDateTime, formatUtc, parseTimestamp } from "./date-time";

describe("parseTimestamp", () => {
  it("parses ISO timestamps and rejects everything else", () => {
    expect(parseTimestamp("2026-09-30T14:03:22.123Z")?.toISOString()).toBe(
      "2026-09-30T14:03:22.123Z",
    );
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

describe("formatUtc", () => {
  it("renders the instant in UTC to the second", () => {
    expect(formatUtc("2026-09-30T14:03:22.123Z")).toBe("2026-09-30 14:03:22 UTC");
    expect(formatUtc("2026-09-30T23:59:59+02:00")).toBe("2026-09-30 21:59:59 UTC");
  });

  it("is null for a value that is not a timestamp", () => {
    expect(formatUtc("x")).toBeNull();
    expect(formatUtc(null)).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("formats with Intl for the viewer and is null for nothing", () => {
    const formatted = formatDateTime("2026-09-30T14:03:22.123Z");
    expect(formatted).toContain("2026");
    expect(formatted).not.toContain("T14:03");
    expect(formatDateTime(null)).toBeNull();
  });
});

describe("DateTime", () => {
  it("renders a time element with a machine value and a UTC tooltip", () => {
    render(<DateTime value="2026-09-30T14:03:22.123Z" />);

    const time = document.querySelector("time");
    expect(time).toHaveAttribute("datetime", "2026-09-30T14:03:22.123Z");
    expect(time).toHaveAttribute("title", "2026-09-30 14:03:22 UTC");
    expect(time).toHaveTextContent("2026");
  });

  it("shows a muted fallback instead of a time for a missing or invalid value", () => {
    const { rerender } = render(<DateTime value={null} />);
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();

    rerender(<DateTime value="garbage" fallback="Unknown" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
