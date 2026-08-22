import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import ExplorePage from "./explore/page";
import FindingsPage from "./findings/page";
import HomePage from "./page";
import RunsPage from "./runs/page";
import ScenariosPage from "./scenarios/page";
import SeedsPage from "./seeds/page";

const emptyPages: Array<[string, () => ReactElement, string, number]> = [
  ["Scenarios", ScenariosPage, "No scenarios yet", 2],
  ["Runs", RunsPage, "No runs yet", 2],
  ["Findings", FindingsPage, "No findings yet", 5],
  ["Explore", ExplorePage, "No sessions yet", 7],
  ["Seeds", SeedsPage, "Seeds are not wired up yet", 3],
];

describe("empty pages", () => {
  it.each(emptyPages)(
    "%s shows its heading and an empty state naming the phase",
    (title, Page, emptyTitle, phase) => {
      render(<Page />);

      expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: emptyTitle })).toBeInTheDocument();
      expect(screen.getByText(`Arrives in Phase ${phase}`)).toBeInTheDocument();
    },
  );

  it("never renders its own main landmark because the shell owns it", () => {
    for (const [, Page] of emptyPages) {
      const { container, unmount } = render(<Page />);
      expect(container.querySelector("main")).toBeNull();
      unmount();
    }
  });
});

describe("home page", () => {
  it("shows placeholder cards that name the phase that fills them", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(screen.getAllByText("Arrives in Phase 8")).toHaveLength(3);
    expect(screen.getByText("Arrives in Phase 10")).toBeInTheDocument();
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByText("Open findings")).toBeInTheDocument();
  });
});
