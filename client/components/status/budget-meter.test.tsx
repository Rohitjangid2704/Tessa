import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BudgetMeter } from "./budget-meter";

describe("BudgetMeter", () => {
  it("shows the spent and maximum cost exactly as the server sent them", () => {
    render(
      <BudgetMeter
        budget={{ max_usd: 5, spent_usd: 0.4213, max_minutes: 30, elapsed_ms: 61_000 }}
      />,
    );

    expect(screen.getByLabelText("Budget")).toBeInTheDocument();
    expect(screen.getByText("$0.4213 of $5.00")).toBeInTheDocument();
    expect(screen.getByText("1 min 1 s of 30 min")).toBeInTheDocument();
  });

  it("renders a zero budget without dividing or hiding anything", () => {
    render(<BudgetMeter budget={{ max_usd: 0, spent_usd: 0, max_minutes: 0, elapsed_ms: 0 }} />);

    expect(screen.getByText("$0.00 of $0.00")).toBeInTheDocument();
    expect(screen.getByText("0 s of 0 min")).toBeInTheDocument();
  });
});
