import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";
import { buildCatalogItem, groupByArea } from "@/mocks/factories/catalog";
import { areaSelectionState, type CatalogSelection } from "../selection";
import type { CatalogItem } from "../types";
import { AreaTree } from "./area-tree";

const ITEMS: CatalogItem[] = [
  buildCatalogItem({ id: "item-a1", feature_id: "alpha.read.one", area: "Alpha" }),
  buildCatalogItem({ id: "item-a2", feature_id: "alpha.read.two", area: "Alpha" }),
  buildCatalogItem({
    id: "item-a3",
    feature_id: "alpha.write.three",
    area: "Alpha",
    kind: "write",
  }),
  buildCatalogItem({ id: "item-b1", feature_id: "beta.flow.one", area: "Beta", kind: "flow" }),
];

const AREAS = groupByArea(ITEMS);

interface RecordingSelection extends CatalogSelection {
  onToggleItem: Mock<CatalogSelection["onToggleItem"]>;
  onToggleArea: Mock<CatalogSelection["onToggleArea"]>;
}

function createSelection(selected: readonly string[]): RecordingSelection {
  const chosen = new Set(selected);
  return {
    isSelected: (itemId) => chosen.has(itemId),
    onToggleItem: vi.fn<CatalogSelection["onToggleItem"]>(),
    onToggleArea: vi.fn<CatalogSelection["onToggleArea"]>(),
  };
}

describe("AreaTree", () => {
  it("lists every area with its feature count and its feature cards", () => {
    render(<AreaTree areas={AREAS} />);

    const tree = screen.getByRole("list", { name: "Feature areas" });
    expect(
      within(tree)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Alpha 3 features", "Beta 1 feature"]);
    expect(
      within(screen.getByRole("list", { name: "Features in Alpha" })).getAllByRole("article"),
    ).toHaveLength(3);
    expect(
      within(screen.getByRole("list", { name: "Features in Beta" })).getAllByRole("article"),
    ).toHaveLength(1);
  });

  it("keeps stable item ids on every card for the plan builder", () => {
    render(<AreaTree areas={AREAS} />);

    expect(screen.getAllByRole("article").map((card) => card.getAttribute("data-item-id"))).toEqual(
      ["item-a1", "item-a2", "item-a3", "item-b1"],
    );
  });

  it("shows how many of an area's features match when it is filtered", () => {
    render(
      <AreaTree
        areas={[{ name: "Alpha", items: ITEMS.slice(0, 1) }]}
        totals={new Map([["Alpha", 3]])}
      />,
    );

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Alpha 1 of 3 features");
  });

  it("collapses and expands an area from its heading button", async () => {
    const user = userEvent.setup();
    render(<AreaTree areas={AREAS} />);
    const trigger = screen.getByRole("button", { name: /^Alpha/ });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Features in Alpha" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Features in Beta" })).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.getByRole("list", { name: "Features in Alpha" })).toBeInTheDocument();
  });

  it("can start with every area collapsed", async () => {
    const user = userEvent.setup();
    render(<AreaTree areas={AREAS} defaultOpen={false} />);

    expect(screen.getByRole("button", { name: /^Alpha/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Beta/ }));

    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("renders no checkboxes without selection state", () => {
    render(<AreaTree areas={AREAS} />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("AreaTree with selection state", () => {
  it("shows a checkbox per feature and per area reflecting the selection", () => {
    render(<AreaTree areas={AREAS} selection={createSelection(["item-a1", "item-b1"])} />);

    expect(screen.getByRole("checkbox", { name: "Select alpha.read.one" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select alpha.read.two" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select every feature in Alpha" })).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
    expect(screen.getByRole("checkbox", { name: "Select every feature in Beta" })).toBeChecked();
  });

  it("reports an item toggle with the whole item", async () => {
    const selection = createSelection([]);
    const user = userEvent.setup();
    render(<AreaTree areas={AREAS} selection={selection} />);

    await user.click(screen.getByRole("checkbox", { name: "Select alpha.write.three" }));

    expect(selection.onToggleItem).toHaveBeenCalledWith(ITEMS[2], true);
  });

  it("reports an area toggle with the area and the new state", async () => {
    const selection = createSelection([]);
    const user = userEvent.setup();
    render(<AreaTree areas={AREAS} selection={selection} />);

    await user.click(screen.getByRole("checkbox", { name: "Select every feature in Alpha" }));

    expect(selection.onToggleArea).toHaveBeenCalledWith(AREAS[0], true);
  });

  it("clears an area that is fully selected", async () => {
    const selection = createSelection(["item-b1"]);
    const user = userEvent.setup();
    render(<AreaTree areas={AREAS} selection={selection} />);

    await user.click(screen.getByRole("checkbox", { name: "Select every feature in Beta" }));

    expect(selection.onToggleArea).toHaveBeenCalledWith(AREAS[1], false);
  });
});

describe("areaSelectionState", () => {
  it.each([
    [[], "none"],
    [["item-a1"], "some"],
    [["item-a1", "item-a2", "item-a3"], "all"],
    [["item-b1"], "none"],
  ] as const)("with %j selected the Alpha area is %s", (selected, expected) => {
    const chosen = new Set<string>(selected);

    expect(areaSelectionState(AREAS[0] as (typeof AREAS)[number], (id) => chosen.has(id))).toBe(
      expected,
    );
  });
});
