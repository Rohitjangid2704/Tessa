import { configure } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/state";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { ServiceTestCard } from "./service-test";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5000 });

beforeEach(async () => {
  await signInAs(ADMIN_USER);
});

const row = (service: string) =>
  document.querySelector(`[data-service="${service}"]`) as HTMLElement;
const testButton = (label: string) =>
  screen.getByRole("button", { name: `Test ${label} connection` });

describe("ServiceTestCard", () => {
  it("lists the five testable services, idle, and not Slack or SMTP", () => {
    renderWithProviders(<ServiceTestCard readOnly={false} />);

    expect(
      Array.from(document.querySelectorAll("[data-service]")).map((item) =>
        item.getAttribute("data-service"),
      ),
    ).toEqual(["laya", "openai", "anthropic", "jev", "temporal"]);
    for (const item of document.querySelectorAll("[data-service]")) {
      expect(item).toHaveAttribute("data-state", "idle");
    }
    expect(screen.getByRole("region", { name: "Connectivity tests" })).toBeInTheDocument();
  });

  it("shows running and then ok with the latency", async () => {
    mockState.faults.apply({ health_slow: 1000 });
    const user = userEvent.setup();
    renderWithProviders(<ServiceTestCard readOnly={false} />);

    await user.click(testButton("Laya"));

    expect(row("laya")).toHaveAttribute("data-state", "running");
    expect(within(row("laya")).getByRole("status")).toHaveTextContent("Testing");
    expect(screen.getByRole("button", { name: "Testing Laya connection" })).toBeDisabled();
    expect(row("temporal")).toHaveAttribute("data-state", "idle");
    await waitFor(() => expect(row("laya")).toHaveAttribute("data-state", "ok"));
    expect(within(row("laya")).getByText("OK")).toBeInTheDocument();
    expect(within(row("laya")).getByText("12 ms")).toBeInTheDocument();
    expect(testButton("Laya")).toBeEnabled();
  });

  it("shows failed with the service's message", async () => {
    mockState.faults.apply({ service_test_fail: ["openai"] });
    const user = userEvent.setup();
    renderWithProviders(<ServiceTestCard readOnly={false} />);

    await user.click(testButton("OpenAI"));

    await waitFor(() => expect(row("openai")).toHaveAttribute("data-state", "failed"));
    expect(within(row("openai")).getByText("Failed")).toBeInTheDocument();
    expect(
      within(row("openai")).getByText("The provider answered 401 Unauthorized"),
    ).toBeInTheDocument();
  });

  it("reports a service that is not configured as failed with that reason", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceTestCard readOnly={false} />);

    await user.click(testButton("Jev"));

    await waitFor(() => expect(row("jev")).toHaveAttribute("data-state", "failed"));
    expect(within(row("jev")).getByText("not configured")).toBeInTheDocument();
  });

  it("replaces an earlier result when the test is run again", async () => {
    mockState.faults.apply({ service_test_fail: ["temporal"] });
    const user = userEvent.setup();
    renderWithProviders(<ServiceTestCard readOnly={false} />);
    await user.click(testButton("Temporal"));
    await waitFor(() => expect(row("temporal")).toHaveAttribute("data-state", "failed"));

    mockState.faults.apply({ service_test_fail: null });
    await user.click(testButton("Temporal"));

    await waitFor(() => expect(row("temporal")).toHaveAttribute("data-state", "ok"));
    expect(within(row("temporal")).queryByText("Failed")).not.toBeInTheDocument();
    expect(within(row("temporal")).getByText("6 ms")).toBeInTheDocument();
  });

  it("shows a request that failed outright as failed with the API's message", async () => {
    server.use(
      http.post("*/api/v1/settings/test/:service", () =>
        HttpResponse.json(
          { error: { code: "internal_error", message: "Boom", request_id: "req-9", details: [] } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ServiceTestCard readOnly={false} />);

    await user.click(testButton("Anthropic"));

    await waitFor(() => expect(row("anthropic")).toHaveAttribute("data-state", "failed"));
    expect(within(row("anthropic")).getByText("Boom")).toBeInTheDocument();
  });

  it("keeps the other services' results when one is tested", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServiceTestCard readOnly={false} />);

    await user.click(testButton("Laya"));
    await waitFor(() => expect(row("laya")).toHaveAttribute("data-state", "ok"));
    await user.click(testButton("OpenAI"));

    await waitFor(() => expect(row("openai")).toHaveAttribute("data-state", "ok"));
    expect(row("laya")).toHaveAttribute("data-state", "ok");
  });

  it("disables every test and says why for someone who is not an admin", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<ServiceTestCard readOnly />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText(/Only admins can run them/)).toBeInTheDocument();
  });
});
