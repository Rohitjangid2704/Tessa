import { describe, expect, it, vi } from "vitest";
import { buildProposalItem } from "@/tests/utils/proposals";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { describeEstimate, ProposalItemCard } from "./proposal-item-card";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const TARGET_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9001";

function renderCard(
  item = buildProposalItem(),
  props: Partial<{ canEdit: boolean; pending: boolean }> = {},
) {
  const onChoose = vi.fn();
  const view = renderWithProviders(
    <ProposalItemCard
      item={item}
      targetId={TARGET_ID}
      canEdit={props.canEdit ?? true}
      pending={props.pending ?? false}
      onChoose={onChoose}
    />,
  );
  return { onChoose, ...view };
}

describe("ProposalItemCard", () => {
  it("shows title, kind, depth, estimate, confidence, risk and status", () => {
    renderCard(
      buildProposalItem({
        title: "Closing an issue works",
        kind: "browser",
        depth: "deep",
        risk: "high",
        confidence: "low",
        estimate: { scenarios: 4, minutes: 6 },
      }),
    );
    const card = screen.getByRole("article", { name: "Closing an issue works" });
    expect(within(card).getByText("Browser")).toBeInTheDocument();
    expect(within(card).getByText("Deep depth")).toBeInTheDocument();
    expect(within(card).getByText("4 scenarios, about 6 min")).toBeInTheDocument();
    expect(within(card).getByText("Low confidence")).toBeInTheDocument();
    expect(within(card).getByText("High risk")).toBeInTheDocument();
    expect(within(card).getByText("Proposed")).toBeInTheDocument();
  });

  it("describes a missing estimate as nothing", () => {
    expect(describeEstimate(null)).toBeNull();
    expect(describeEstimate({ scenarios: 1, minutes: 2 })).toBe("1 scenario, about 2 min");
  });

  it("renders reasons, notes, needs and evidence as text", () => {
    renderCard(
      buildProposalItem({
        reasons: [{ code: "money_path", note: "Posts to the ledger" }, { code: "user_visible" }],
        needs: ["seed", "credentials"],
        evidence: "src/billing/folio.py, db/migrations/0042_folio.sql",
      }),
    );
    const reasons = screen.getByRole("list", { name: "Reasons" });
    expect(within(reasons).getAllByRole("listitem")).toHaveLength(2);
    expect(reasons).toHaveTextContent("Money path: Posts to the ledger");
    expect(reasons).toHaveTextContent("User visible");
    const needs = screen.getByRole("list", { name: "Needs" });
    expect(needs).toHaveTextContent("Needs a seed");
    expect(needs).toHaveTextContent("Needs credentials");
    expect(screen.getByText(/src\/billing\/folio\.py/)).toBeInTheDocument();
  });

  it("never turns proposal text into HTML", () => {
    const { container } = renderCard(
      buildProposalItem({
        title: '<img src="x" onerror="alert(1)">Folio',
        evidence: "<script>alert(1)</script>",
        note: '<a href="https://evil.test">click</a>',
        status: "declined",
        reasons: [{ code: "bug_history", note: "<b>bold</b>" }],
        needs: [],
      }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(
      [...container.querySelectorAll("script")].some((node) =>
        (node.textContent ?? "").includes("alert(1)"),
      ),
    ).toBe(false);
    expect(container.querySelector("a[href='https://evil.test']")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent(
      '<img src="x" onerror="alert(1)">Folio',
    );
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.getByText(/<a href="https:\/\/evil.test">click<\/a>/)).toBeInTheDocument();
  });

  it("ticks and unticks through the checkbox", async () => {
    const user = userEvent.setup();
    const item = buildProposalItem({ title: "Open issues" });
    const { onChoose, rerender } = renderCard(item);
    await user.click(screen.getByRole("checkbox", { name: "Select Open issues" }));
    expect(onChoose).toHaveBeenCalledWith(item, "selected");

    const selected = { ...item, status: "selected" as const };
    rerender(
      <ProposalItemCard
        item={selected}
        targetId={TARGET_ID}
        canEdit
        pending={false}
        onChoose={onChoose}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Select Open issues" });
    expect(box).toBeChecked();
    await user.click(box);
    expect(onChoose).toHaveBeenLastCalledWith(selected, "proposed");
  });

  it("opens a note field to decline and sends the note", async () => {
    const user = userEvent.setup();
    const item = buildProposalItem({ title: "Open issues" });
    const { onChoose } = renderCard(item);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Decline Open issues" }));
    const form = screen.getByRole("form", { name: "Decline Open issues" });
    await user.type(within(form).getByRole("textbox"), "Covered by vendor tests");
    await user.click(within(form).getByRole("button", { name: "Decline item" }));
    expect(onChoose).toHaveBeenCalledWith(item, "declined", "Covered by vendor tests");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("cancels a decline without calling out", async () => {
    const user = userEvent.setup();
    const { onChoose } = renderCard();
    await user.click(screen.getByRole("button", { name: /^Decline/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Decline/ })).toBeInTheDocument();
  });

  it("shows the note of a declined item and restores it", async () => {
    const user = userEvent.setup();
    const item = buildProposalItem({ title: "Open issues", status: "declined", note: "later" });
    const { onChoose } = renderCard(item);
    expect(screen.getByText("later")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore Open issues" }));
    expect(onChoose).toHaveBeenCalledWith(item, "proposed");
  });

  it("keeps authored and covered cards read-only with links", () => {
    const scenarioId = "0198f6f2-4c2a-7d10-9c1e-0000000000aa";
    const { unmount } = renderCard(
      buildProposalItem({
        status: "authored",
        scenario_ids: [scenarioId],
        cell_ids: ["a", "b"],
        title: "Authored one",
      }),
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Scenario 1/ })).toHaveAttribute(
      "href",
      `/scenarios/${scenarioId}`,
    );
    expect(screen.getByRole("link", { name: /2 coverage cells/ })).toBeInTheDocument();
    unmount();

    renderCard(buildProposalItem({ status: "covered", cell_ids: ["a"], title: "Covered one" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /1 coverage cell/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/coverage"),
    );
  });

  it("hides every control for a viewer", () => {
    renderCard(buildProposalItem(), { canEdit: false });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("marks a pending card busy and blocks its controls", () => {
    renderCard(buildProposalItem({ title: "Open issues" }), { pending: true });
    expect(screen.getByRole("article", { name: "Open issues" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("checkbox", { name: "Select Open issues" })).toBeDisabled();
  });
});
