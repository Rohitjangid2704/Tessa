import { describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { proposalsStore } from "@/mocks/stage11/proposals-store";
import { signInAs } from "@/tests/utils/api-session";
import { buildCoverageCell } from "@/tests/utils/coverage-cells";
import { renderWithProviders, screen, waitFor, within } from "@/tests/utils/render";
import { emptyCounts } from "../grid-model";
import { itemIdsCoveringAll, proposalItemIdsOf, proposedCellCount, summarizeSelection } from "../selection";
import { CellProposalItems } from "./cell-proposal-items";
import { HeatmapCell } from "./heatmap-cell";
import { Legend } from "./legend";
import { SelectionBar } from "./selection-bar";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const ITEM_A = "0198f6f2-4c2a-7d10-9c1e-0000000000a1";
const ITEM_B = "0198f6f2-4c2a-7d10-9c1e-0000000000b2";

function renderCell(proposalItemIds?: string[]) {
  const cell = buildCoverageCell({ proposal_item_ids: proposalItemIds });
  renderWithProviders(
    <div role="grid">
      <div role="row">
        <HeatmapCell
          cell={cell}
          featureTitle="Open issues"
          active
          selected={false}
          selectionMode={false}
          flashKey={undefined}
          onActivate={vi.fn()}
          onFocusCell={vi.fn()}
        />
      </div>
    </div>,
  );
  return cell;
}

describe("proposal helpers of the coverage map", () => {
  it("treats a missing field as no items", () => {
    expect(proposalItemIdsOf(buildCoverageCell())).toEqual([]);
  });

  it("returns the union of item ids only when every cell maps to an item", () => {
    const a = buildCoverageCell({ proposal_item_ids: [ITEM_A] });
    const b = buildCoverageCell({ proposal_item_ids: [ITEM_A, ITEM_B] });
    const none = buildCoverageCell({ proposal_item_ids: [] });
    expect(itemIdsCoveringAll([a, b])).toEqual([ITEM_A, ITEM_B]);
    expect(itemIdsCoveringAll([a, none])).toBeNull();
    expect(itemIdsCoveringAll([a, buildCoverageCell()])).toBeNull();
    expect(itemIdsCoveringAll([])).toBeNull();
  });

  it("counts the cells that carry the marker", () => {
    expect(
      proposedCellCount([
        buildCoverageCell({ proposal_item_ids: [ITEM_A] }),
        buildCoverageCell({ proposal_item_ids: [] }),
        buildCoverageCell(),
      ]),
    ).toBe(1);
  });
});

describe("HeatmapCell marker", () => {
  it("draws the corner mark and says so in the label", () => {
    const cell = renderCell([ITEM_A]);
    const button = screen.getByRole("button", { name: /proposed in the test proposal/ });
    expect(button).toHaveAttribute("data-cell-id", cell.id);
    expect(button.querySelector("[data-slot=proposed-mark]")).not.toBeNull();
  });

  it("draws nothing for a cell without items", () => {
    renderCell([]);
    const button = screen.getByRole("button");
    expect(button.querySelector("[data-slot=proposed-mark]")).toBeNull();
    expect(button).not.toHaveAccessibleName(/proposed/);
  });
});

describe("Legend entry", () => {
  const totals = { blocked: 0, covered: 1, empty: 2, generated: 0, needs_author: 0 };

  it("lists Proposed with its count as text", () => {
    renderWithProviders(
      <Legend totals={totals} active={[]} onToggle={vi.fn()} onClear={vi.fn()} proposedCount={3} />,
    );
    const entry = document.querySelector("[data-slot=legend-proposed]");
    expect(entry).toHaveTextContent("Proposed3");
  });

  it("leaves the entry out when no cell is proposed", () => {
    renderWithProviders(<Legend totals={totals} active={[]} onToggle={vi.fn()} onClear={vi.fn()} />);
    expect(document.querySelector("[data-slot=legend-proposed]")).toBeNull();
  });
});

describe("SelectionBar author chip", () => {
  const access = { canGenerate: true, canAuthor: true, productionTarget: false };

  function renderBar(cells: ReturnType<typeof buildCoverageCell>[]) {
    renderWithProviders(
      <SelectionBar
        summary={summarizeSelection(cells)}
        access={access}
        onGenerate={vi.fn()}
        onAuthor={vi.fn()}
        onClear={vi.fn()}
      />,
    );
  }

  it("carries the item ids when every selected cell maps to items", () => {
    renderBar([
      buildCoverageCell({ status: "empty", proposal_item_ids: [ITEM_A] }),
      buildCoverageCell({ status: "needs_author", proposal_item_ids: [ITEM_A, ITEM_B] }),
    ]);
    expect(screen.getByText(`/tessa:author ${ITEM_A},${ITEM_B}`)).toBeInTheDocument();
  });

  it("carries the cell ids when one cell has no item", () => {
    const withItem = buildCoverageCell({ status: "empty", proposal_item_ids: [ITEM_A] });
    const without = buildCoverageCell({ status: "empty" });
    renderBar([withItem, without]);
    expect(screen.getByText(`/tessa:author ${withItem.id},${without.id}`)).toBeInTheDocument();
  });

  it("shows no chip when nothing can be authored", () => {
    renderBar([buildCoverageCell({ status: "covered" })]);
    expect(screen.queryByText(/tessa:author/)).not.toBeInTheDocument();
  });

  it("keeps the status counts", () => {
    renderBar([buildCoverageCell({ status: "empty" })]);
    expect(within(screen.getByRole("region", { name: "Selected cells" })).getByText("1 cell selected")).toBeInTheDocument();
    expect(emptyCounts().empty).toBe(0);
  });
});

describe("CellProposalItems", () => {
  it("lists the titles of the items with their status and a link to the board", async () => {
    await signInAs(MEMBER_USER);
    const items = (proposalsStore.current(STAGE_ONE_IDS.gracie)?.items ?? []).slice(0, 2);
    renderWithProviders(
      <CellProposalItems targetId={STAGE_ONE_IDS.gracie} itemIds={items.map((item) => item.id)} />,
    );
    for (const item of items) {
      const link = await screen.findByRole("link", { name: item.title });
      expect(link).toHaveAttribute(
        "href",
        expect.stringContaining(`/targets/${STAGE_ONE_IDS.gracie}/proposal`),
      );
    }
    await waitFor(() =>
      expect(document.querySelectorAll("[data-item-status]").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("renders nothing for a cell without items", () => {
    renderWithProviders(<CellProposalItems targetId={STAGE_ONE_IDS.gracie} itemIds={[]} />);
    expect(document.querySelector("[data-slot=cell-proposal-items]")).toBeNull();
  });
});
