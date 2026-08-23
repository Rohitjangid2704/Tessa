import { describe, expect, it } from "vitest";
import { buildCompleteness } from "@/mocks/factories/bundles";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import { CompletenessPanel, creditOf, describeBarDistance } from "./completeness-panel";

const PARTIAL = buildCompleteness({
  required_sections: { earned: 20 },
  feature_interface_roles: {
    earned: 12,
    detail: "3 of 12 features name no role or no interface",
    fix_hint: "Give every feature at least one interface id and one role id",
  },
  feature_examples: {
    earned: 8,
    detail: "3 of 12 features have no concrete example",
    fix_hint: "Add one example with the expected behaviour to each feature without one",
  },
  oracle_read_only: {
    earned: 0,
    detail: "No oracle files",
    fix_hint: "Add oracle/<name>.sql",
  },
  env_template_coverage: { earned: 10, detail: "2 placeholders are missing", fix_hint: "Add them" },
  seeds_reset_and_hash: { earned: 0, detail: "No seeds/ folder", fix_hint: "Add a reset script" },
});

const FULL = buildCompleteness({
  required_sections: { earned: 20 },
  feature_interface_roles: { earned: 15 },
  feature_examples: { earned: 20 },
  oracle_read_only: { earned: 15 },
  env_template_coverage: { earned: 15 },
  seeds_reset_and_hash: { earned: 15 },
});

function check(id: string): HTMLElement {
  const element = document.querySelector(`[data-check='${id}']`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`check ${id} is not rendered`);
  }
  return element;
}

describe("creditOf", () => {
  it("is full only when the server says passed", () => {
    expect(creditOf({ id: "x", label: "x", passed: true, weight: 15, earned: 15 })).toBe("full");
    expect(creditOf({ id: "x", label: "x", passed: false, weight: 15, earned: 12 })).toBe(
      "partial",
    );
    expect(creditOf({ id: "x", label: "x", passed: false, weight: 15, earned: 0 })).toBe("none");
  });
});

describe("describeBarDistance", () => {
  it("says how far from the bar the score is", () => {
    expect(describeBarDistance(55, 80)).toBe("25 points short of the bar of 80.");
    expect(describeBarDistance(79, 80)).toBe("1 point short of the bar of 80.");
    expect(describeBarDistance(80, 80)).toBe("Exactly on the bar of 80.");
    expect(describeBarDistance(92, 80)).toBe("12 points above the bar of 80.");
  });
});

describe("CompletenessPanel with partial credit", () => {
  it("shows the score, the bar marker and a below-bar status", () => {
    renderWithProviders(<CompletenessPanel completeness={PARTIAL} validationStatus="valid" />);

    const gauge = screen.getByRole("meter", { name: "Completeness score" });
    expect(gauge).toHaveAttribute("aria-valuenow", "50");
    expect(gauge).toHaveAttribute("aria-valuemax", "100");
    expect(gauge).toHaveAttribute("aria-valuetext", "50 of 100, bar 80, below the bar");
    expect(screen.getByText("Bar 80")).toBeInTheDocument();
    expect(document.querySelector("[data-slot='score-gauge-marker']")).toHaveStyle({ left: "80%" });
    expect(document.querySelector("[data-slot='score-gauge-fill']")).toHaveStyle({ width: "50%" });
    expect(screen.getByText("Below bar")).toBeInTheDocument();
    expect(screen.getByText("30 points short of the bar of 80.")).toBeInTheDocument();
  });

  it("lists the six weighted checks with earned of weight", () => {
    renderWithProviders(<CompletenessPanel completeness={PARTIAL} validationStatus="valid" />);

    const list = screen.getByRole("list", { name: "Completeness checks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    const expected: Record<string, [string, number, number]> = {
      required_sections: ["Required manifest sections", 20, 20],
      feature_interface_roles: ["Features name interfaces and roles", 12, 15],
      feature_examples: ["Features carry concrete examples", 8, 20],
      oracle_read_only: ["Read-only oracle per computable feature", 0, 15],
      env_template_coverage: ["env.template covers every placeholder", 10, 15],
      seeds_reset_and_hash: ["Seeds with a reset script and a hash command", 0, 15],
    };
    for (const [id, [label, earned, weight]] of Object.entries(expected)) {
      const row = within(check(id));
      expect(row.getByRole("heading", { name: label })).toBeInTheDocument();
      expect(row.getByText(String(earned), { selector: "span.font-semibold" })).toBeInTheDocument();
      const meter = row.getByRole("meter");
      expect(meter).toHaveAttribute("aria-valuenow", String(earned));
      expect(meter).toHaveAttribute("aria-valuemax", String(weight));
      expect(meter).toHaveAccessibleName(`${label}, points earned`);
    }
    expect(PARTIAL.checks.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
  });

  it("tells full, partial and no credit apart with text", () => {
    renderWithProviders(<CompletenessPanel completeness={PARTIAL} validationStatus="valid" />);

    expect(check("required_sections")).toHaveAttribute("data-credit", "full");
    expect(within(check("required_sections")).getByText("Full credit")).toBeInTheDocument();
    expect(check("feature_examples")).toHaveAttribute("data-credit", "partial");
    expect(within(check("feature_examples")).getByText("Partial credit")).toBeInTheDocument();
    expect(check("seeds_reset_and_hash")).toHaveAttribute("data-credit", "none");
    expect(within(check("seeds_reset_and_hash")).getByText("No credit")).toBeInTheDocument();
  });

  it("shows detail and fix hint for checks below full credit only", () => {
    renderWithProviders(<CompletenessPanel completeness={PARTIAL} validationStatus="valid" />);

    const partial = within(check("feature_examples"));
    expect(partial.getByText("3 of 12 features have no concrete example")).toBeInTheDocument();
    expect(
      partial.getByText("Add one example with the expected behaviour to each feature without one"),
    ).toBeInTheDocument();
    expect(partial.getByText(/How to fix/)).toBeInTheDocument();
    expect(within(check("required_sections")).queryByText(/How to fix/)).not.toBeInTheDocument();
    expect(screen.getByText("5 of 6 checks did not earn full credit.")).toBeInTheDocument();
  });
});

describe("CompletenessPanel at the other extremes", () => {
  it("reports a perfect score without fix hints", () => {
    renderWithProviders(<CompletenessPanel completeness={FULL} validationStatus="valid" />);

    expect(screen.getByRole("meter", { name: "Completeness score" })).toHaveAttribute(
      "aria-valuetext",
      "100 of 100, bar 80, meets the bar",
    );
    expect(screen.getByText("Meets bar")).toBeInTheDocument();
    expect(screen.getByText("Every check earned full credit.")).toBeInTheDocument();
    expect(screen.queryByText(/How to fix/)).not.toBeInTheDocument();
  });

  it("can meet the bar while some checks lost points", () => {
    const mostly = buildCompleteness({
      required_sections: { earned: 20 },
      feature_interface_roles: { earned: 15 },
      feature_examples: { earned: 20 },
      oracle_read_only: { earned: 10, detail: "11 of 15", fix_hint: "Add oracles" },
      env_template_coverage: { earned: 12, detail: "2 missing", fix_hint: "Add lines" },
      seeds_reset_and_hash: { earned: 15 },
    });

    renderWithProviders(<CompletenessPanel completeness={mostly} validationStatus="valid" />);

    expect(screen.getByText("Meets bar")).toBeInTheDocument();
    expect(screen.getByText("12 points above the bar of 80.")).toBeInTheDocument();
    expect(screen.getByText("2 of 6 checks did not earn full credit.")).toBeInTheDocument();
    expect(within(check("oracle_read_only")).getByText("How to fix:")).toBeInTheDocument();
  });

  it("explains that an invalid bundle is scored from the raw manifest", () => {
    renderWithProviders(<CompletenessPanel completeness={FULL} validationStatus="invalid" />);

    expect(
      screen.getByText(/scored from the raw manifest|score is read from the raw manifest/i),
    ).toBeInTheDocument();
  });
});
