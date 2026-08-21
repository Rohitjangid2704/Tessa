import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders the title as the page's h1 with an optional description", () => {
    render(<PageHeader title="Runs" description="Plans executed against a target." />);

    expect(screen.getByRole("heading", { level: 1, name: "Runs" })).toBeInTheDocument();
    expect(screen.getByText("Plans executed against a target.")).toBeInTheDocument();
  });

  it("renders actions beside the title", () => {
    render(<PageHeader title="Targets" actions={<button type="button">New target</button>} />);

    expect(screen.getByRole("button", { name: "New target" })).toBeInTheDocument();
  });

  it("omits the description and actions when absent", () => {
    const { container } = render(<PageHeader title="Labels" />);

    expect(container.querySelector("p")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
