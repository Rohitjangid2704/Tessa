import { useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mockState } from "@/mocks/handlers";
import { server } from "./server";
import { renderWithProviders, screen, userEvent } from "./render";
import { bearer, mintApiToken } from "./tokens";

const API = "http://localhost:8000";

function HealthProbe() {
  const query = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const response = await fetch(`${API}/health`);
      return (await response.json()) as { status: string };
    },
  });
  if (query.isPending) {
    return <p>loading</p>;
  }
  return <p>health: {query.data?.status}</p>;
}

describe("vitest setup", () => {
  it("registers the jest-dom matchers and renders inside the providers", async () => {
    renderWithProviders(<HealthProbe />);

    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(await screen.findByText("health: ok")).toBeVisible();
  });

  it("gives each render its own query client", () => {
    const first = renderWithProviders(<p>one</p>);
    const second = renderWithProviders(<p>two</p>);
    expect(first.queryClient).not.toBe(second.queryClient);
  });

  it("supports user events", async () => {
    renderWithProviders(<button type="button">press</button>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "press" }));
    expect(screen.getByRole("button", { name: "press" })).toBeEnabled();
  });

  it("polyfills the browser APIs jsdom lacks", () => {
    expect(typeof window.matchMedia("(min-width: 1px)").matches).toBe("boolean");
    expect(typeof ResizeObserver).toBe("function");
    expect(typeof IntersectionObserver).toBe("function");
  });
});

describe("mock handlers on setupServer", () => {
  it("serves the contract on the localhost and the 127.0.0.1 alias", async () => {
    const token = await mintApiToken();

    const byName = await fetch(`${API}/api/v1/users/me`, { headers: bearer(token) });
    const byAddress = await fetch("http://127.0.0.1:8000/api/v1/users/me", {
      headers: bearer(token),
    });

    expect(await byName.json()).toMatchObject({ email: "admin@tessa.local", role: "admin" });
    expect(byAddress.status).toBe(200);
  });

  it("errors on a request no handler knows", async () => {
    await expect(fetch("http://localhost:9999/unmocked")).rejects.toThrow();
  });

  it("lets a test override a handler with server.use", async () => {
    server.use(http.get(`${API}/health`, () => HttpResponse.json({ status: "degraded" })));

    renderWithProviders(<HealthProbe />);

    expect(await screen.findByText("health: degraded")).toBeVisible();
  });

  it("starts every test from a reset state, part one", async () => {
    mockState.faults.apply({ hello_503: true, latency_ms: 5 });
    await fetch(`${API}/__mock/reset`, { method: "POST" });
    expect(mockState.faults.snapshot().hello_503).toBe(false);
  });

  it("starts every test from a reset state, part two", () => {
    mockState.faults.apply({ verify_429: true });
    expect(mockState.faults.snapshot().verify_429).toBe(true);
  });

  it("does not leak the previous test's faults", () => {
    expect(mockState.faults.snapshot()).toMatchObject({
      verify_429: false,
      hello_503: false,
      latency_ms: 0,
    });
  });

  it("toggles faults through the control endpoint like the e2e tests do", async () => {
    await fetch(`${API}/__mock/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dependencies_down: true }),
    });
    const token = await mintApiToken();

    const response = await fetch(`${API}/health/dependencies`, { headers: bearer(token) });

    expect((await response.json()).db.status).toBe("down");
  });
});
