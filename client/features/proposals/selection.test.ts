import { describe, expect, it } from "vitest";
import { buildProposal, buildProposalItem } from "@/tests/utils/proposals";
import {
  applyItemChange,
  changedItemIds,
  countByStatus,
  isLocked,
  itemsToClear,
  itemsToSelect,
  selectedItemIds,
  summarizeArea,
} from "./selection";

const mixed = [
  buildProposalItem({ status: "proposed" }),
  buildProposalItem({ status: "proposed" }),
  buildProposalItem({ status: "selected" }),
  buildProposalItem({ status: "declined", note: "later" }),
  buildProposalItem({ status: "authored" }),
  buildProposalItem({ status: "covered" }),
];

describe("area selection with mixed statuses", () => {
  it("selects only the proposed items", () => {
    expect(itemsToSelect(mixed).map((item) => item.id)).toEqual([mixed[0]?.id, mixed[1]?.id]);
  });

  it("clears only the selected items", () => {
    expect(itemsToClear(mixed).map((item) => item.id)).toEqual([mixed[2]?.id]);
  });

  it("summarizes the area", () => {
    expect(summarizeArea(mixed)).toEqual({
      total: 6,
      selected: 1,
      declined: 1,
      locked: 2,
      selectable: 2,
    });
  });

  it("does nothing for an area whose items are all locked or declined", () => {
    const quiet = [
      buildProposalItem({ status: "authored" }),
      buildProposalItem({ status: "declined" }),
    ];
    expect(itemsToSelect(quiet)).toEqual([]);
    expect(itemsToClear(quiet)).toEqual([]);
  });

  it("treats authored and covered items as locked", () => {
    expect(mixed.map(isLocked)).toEqual([false, false, false, false, true, true]);
  });

  it("lists the selected ids and counts every status", () => {
    expect(selectedItemIds(mixed)).toEqual([mixed[2]?.id]);
    expect(countByStatus(mixed)).toEqual({
      proposed: 2,
      selected: 1,
      declined: 1,
      authored: 1,
      covered: 1,
    });
  });
});

describe("applyItemChange", () => {
  const proposal = buildProposal(mixed);

  it("returns null for no proposal", () => {
    expect(applyItemChange(null, { ids: ["x"], choice: "selected" })).toBeNull();
  });

  it("ticks the named items and leaves the others alone", () => {
    const next = applyItemChange(proposal, { ids: [mixed[0]?.id ?? ""], choice: "selected" });
    expect(next?.items.map((item) => item.status)).toEqual([
      "selected",
      "proposed",
      "selected",
      "declined",
      "authored",
      "covered",
    ]);
  });

  it("never changes a locked item", () => {
    const next = applyItemChange(proposal, {
      ids: [mixed[4]?.id ?? "", mixed[5]?.id ?? ""],
      choice: "declined",
    });
    expect(next?.items.slice(4).map((item) => item.status)).toEqual(["authored", "covered"]);
  });

  it("sets a trimmed note, clears it on reset and keeps it on a tick", () => {
    const declined = applyItemChange(proposal, {
      ids: [mixed[0]?.id ?? ""],
      choice: "declined",
      note: "  not now  ",
    });
    expect(declined?.items[0]?.note).toBe("not now");
    const keptOnTick = applyItemChange(proposal, { ids: [mixed[3]?.id ?? ""], choice: "selected" });
    expect(keptOnTick?.items[3]?.note).toBe("later");
    const reset = applyItemChange(proposal, { ids: [mixed[3]?.id ?? ""], choice: "proposed" });
    expect(reset?.items[3]?.note).toBeNull();
  });

  it("reports which items differ from the base", () => {
    const next = applyItemChange(proposal, { ids: [mixed[0]?.id ?? ""], choice: "selected" });
    expect([...changedItemIds(proposal, next)]).toEqual([mixed[0]?.id]);
    expect(changedItemIds(proposal, proposal).size).toBe(0);
    expect(changedItemIds(null, proposal).size).toBe(0);
  });
});
