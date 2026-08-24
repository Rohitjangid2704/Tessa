import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { renderWithProviders, screen, userEvent } from "@/tests/utils/render";
import { ProposalFooter } from "./proposal-footer";

const IDS = Array.from(
  { length: 25 },
  (_, index) => `0198f6f2-4c2a-7d10-9c1e-${String(index).padStart(12, "0")}`,
);

function renderFooter(props: Partial<Parameters<typeof ProposalFooter>[0]> = {}) {
  const onPlan = vi.fn();
  renderWithProviders(
    <ProposalFooter
      selectedIds={[]}
      canPlan
      planning={false}
      planError={null}
      onPlan={onPlan}
      {...props}
    />,
  );
  return { onPlan };
}

describe("ProposalFooter", () => {
  it("disables Plan from selection with nothing selected and says so", () => {
    renderFooter();
    expect(screen.getByRole("button", { name: "Plan from selection" })).toBeDisabled();
    expect(screen.getByText("0 items selected")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is selected yet/)).toBeInTheDocument();
    expect(screen.queryByText(/tessa:author/)).not.toBeInTheDocument();
  });

  it("enables Plan, counts the items and shows the author command with their ids", async () => {
    const user = userEvent.setup();
    const { onPlan } = renderFooter({ selectedIds: IDS.slice(0, 2) });
    expect(screen.getByText("2 items selected")).toBeInTheDocument();
    expect(screen.getByText(`/tessa:author ${IDS[0]},${IDS[1]}`)).toBeInTheDocument();
    const plan = screen.getByRole("button", { name: "Plan from selection" });
    expect(plan).toBeEnabled();
    await user.click(plan);
    expect(onPlan).toHaveBeenCalledTimes(1);
  });

  it("says one item in the singular", () => {
    renderFooter({ selectedIds: IDS.slice(0, 1) });
    expect(screen.getByText("1 item selected")).toBeInTheDocument();
  });

  it("drops the ids above twenty and points at the open proposal", () => {
    renderFooter({ selectedIds: IDS });
    expect(screen.getByText("/tessa:author")).toBeInTheDocument();
    expect(screen.getByText(/More than 20 items/)).toBeInTheDocument();
  });

  it("blocks the button while planning", () => {
    renderFooter({ selectedIds: IDS.slice(0, 1), planning: true });
    expect(screen.getByRole("button", { name: "Planning" })).toBeDisabled();
  });

  it("hides Plan for a viewer", () => {
    renderFooter({ canPlan: false, selectedIds: IDS.slice(0, 1) });
    expect(screen.queryByRole("button", { name: "Plan from selection" })).not.toBeInTheDocument();
  });

  it("shows a plan error with its request id", () => {
    renderFooter({
      selectedIds: IDS.slice(0, 1),
      planError: new ApiError({
        status: 422,
        code: "validation_failed",
        message: "Select at least one item of the proposal before planning",
        requestId: "req-123",
      }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save the plan.");
    expect(screen.getByText("Request ID: req-123")).toBeInTheDocument();
  });
});
