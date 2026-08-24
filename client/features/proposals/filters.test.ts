import { describe, expect, it } from "vitest";
import { buildProposalItem } from "@/tests/utils/proposals";
import {
  applyProposalFilters,
  areaNamesOf,
  DEFAULT_PROPOSAL_SORT,
  groupItemsByArea,
  proposalFiltersCodec,
  proposalFiltersSchema,
  sortProposalItems,
} from "./filters";

function parse(query: string) {
  return proposalFiltersCodec.parse(new URLSearchParams(query));
}

describe("proposal filters in the URL", () => {
  it("parses repeated values and drops unknown ones", () => {
    const values = parse("risk=high&risk=low&risk=bogus&status=selected&area=Billing&area=Reports");
    expect(values).toEqual({
      risk: ["high", "low"],
      status: ["selected"],
      area: ["Billing", "Reports"],
      sort: undefined,
    });
  });

  it("falls back to nothing for an unknown sort", () => {
    expect(parse("sort=weird").sort).toBeUndefined();
    expect(parse("sort=title").sort).toBe("title");
  });

  it("round-trips and leaves the default sort out of the URL", () => {
    const values = parse("risk=high&sort=risk&area=Reports");
    const written = proposalFiltersCodec.serialize(values).toString();
    expect(written).toBe("risk=high&area=Reports");
    expect(proposalFiltersCodec.activeKeys(values)).toEqual(["risk", "area"]);
  });

  it("exposes the zod schema", () => {
    const parsed = proposalFiltersSchema.parse({
      risk: ["medium"],
      status: ["authored", "covered"],
      area: ["A"],
      sort: ["confidence"],
    });
    expect(parsed.sort).toBe("confidence");
    expect(parsed.status).toEqual(["authored", "covered"]);
  });
});

describe("filtering, sorting and grouping", () => {
  const items = [
    buildProposalItem({ title: "Charlie", area: "Billing", risk: "low", confidence: "high" }),
    buildProposalItem({ title: "Alpha", area: "Reports", risk: "high", confidence: "low" }),
    buildProposalItem({
      title: "Bravo",
      area: "Reports",
      risk: "medium",
      confidence: "medium",
      status: "selected",
    }),
  ];

  it("filters by risk, status and area together", () => {
    expect(applyProposalFilters(items, { risk: ["high", "medium"] }).map((i) => i.title)).toEqual([
      "Alpha",
      "Bravo",
    ]);
    expect(
      applyProposalFilters(items, { risk: ["high", "medium"], status: ["selected"] }).map(
        (i) => i.title,
      ),
    ).toEqual(["Bravo"]);
    expect(applyProposalFilters(items, { area: ["Billing"] }).map((i) => i.title)).toEqual([
      "Charlie",
    ]);
    expect(applyProposalFilters(items, {})).toHaveLength(3);
  });

  it("sorts by risk, title or confidence without mutating the input", () => {
    const before = items.map((item) => item.title);
    expect(sortProposalItems(items, DEFAULT_PROPOSAL_SORT).map((i) => i.title)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(sortProposalItems(items, "title").map((i) => i.title)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(sortProposalItems(items, "confidence").map((i) => i.title)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(items.map((item) => item.title)).toEqual(before);
  });

  it("groups by area in alphabetical order and lists the areas", () => {
    const groups = groupItemsByArea(items);
    expect(groups.map((group) => [group.area, group.items.length])).toEqual([
      ["Billing", 1],
      ["Reports", 2],
    ]);
    expect(areaNamesOf(items)).toEqual(["Billing", "Reports"]);
  });
});
