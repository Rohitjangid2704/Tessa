import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorState } from "./error-state";

describe("ErrorState", () => {
  it("announces the title, description and request id as an alert", () => {
    render(<ErrorState title="Boom" description="It broke" requestId="req-1" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Boom");
    expect(alert).toHaveTextContent("It broke");
    expect(alert).toHaveTextContent("Request ID: req-1");
  });

  it("offers a retry that calls back", async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Boom" onRetry={onRetry} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders an extra action next to the retry", () => {
    render(
      <ErrorState title="Not found" action={<button type="button">Back to targets</button>} />,
    );

    expect(screen.getByRole("button", { name: "Back to targets" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
