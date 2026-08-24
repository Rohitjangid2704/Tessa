import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithStream } from "@/tests/utils/run-stream-harness";
import { screen, userEvent, within } from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { RunBody, RUN_BODY_SECTIONS, RUN_BODY_TABS_BELOW_PX } = await import("./run-body");

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubViewport(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(next: boolean) {
      matches = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

const RUN_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11";

describe("RunBody wide", () => {
  it("stacks tiles, scenarios and the event log without tabs", () => {
    stubViewport(true);
    renderWithStream(<RunBody runId={RUN_ID} />);

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("region", { name: "Live tiles" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Scenarios" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Event log" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="run-body"]')).toHaveAttribute(
      "data-layout",
      "stacked",
    );
  });

  it("lets the tile grid span both columns and the other sections share a row", () => {
    stubViewport(true);
    renderWithStream(<RunBody runId={RUN_ID} />);

    expect(document.querySelector('[data-section="tiles"]')?.className).toContain("col-span-2");
    expect(document.querySelector('[data-section="scenarios"]')?.className).not.toContain(
      "col-span-2",
    );
    expect(document.querySelector('[data-section="events"]')?.className).not.toContain(
      "col-span-2",
    );
  });
});

describe("RunBody narrow", () => {
  it("switches to tabs below the breakpoint and keeps every section mounted", async () => {
    stubViewport(false);
    renderWithStream(<RunBody runId={RUN_ID} />);

    const tabs = screen.getByRole("tablist", { name: "Run sections" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Tiles", "Scenarios", "Events"]);
    expect(screen.getByRole("tab", { name: "Tiles" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Event log", hidden: true })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Events" }));

    expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector('[data-section="events"]')).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(document.querySelector('[data-section="tiles"]')).toHaveAttribute(
      "data-state",
      "inactive",
    );
  });

  it("moves between tabs with the arrow keys", async () => {
    stubViewport(false);
    renderWithStream(<RunBody runId={RUN_ID} />);

    screen.getByRole("tab", { name: "Tiles" }).focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Scenarios" })).toHaveFocus();
  });

  it("follows a viewport change in both directions without losing the sections", () => {
    const viewport = stubViewport(false);
    renderWithStream(<RunBody runId={RUN_ID} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();

    act(() => viewport.resize(true));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("region", { name: "Scenarios" })).toBeInTheDocument();

    act(() => viewport.resize(false));
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });
});

describe("RunBody sections", () => {
  it("defaults to the three slots in the documented order", () => {
    expect(RUN_BODY_SECTIONS.map((section) => section.id)).toEqual([
      "tiles",
      "scenarios",
      "events",
    ]);
    expect(RUN_BODY_TABS_BELOW_PX).toBe(900);
  });

  it("renders an added section as one more tab and one more block", async () => {
    stubViewport(false);
    const sections = [
      ...RUN_BODY_SECTIONS,
      {
        id: "findings",
        label: "Findings",
        span: "half" as const,
        render: () => <p>Findings of this run</p>,
      },
    ];
    renderWithStream(<RunBody runId={RUN_ID} sections={sections} />);

    await userEvent.click(screen.getByRole("tab", { name: "Findings" }));

    expect(screen.getByText("Findings of this run")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Findings" })).toHaveAttribute("aria-selected", "true");
  });
});
