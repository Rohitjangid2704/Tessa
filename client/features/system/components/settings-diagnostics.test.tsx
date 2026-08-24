import { delay, http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockState } from "@/mocks/handlers";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { SettingsDiagnostics } from "./settings-diagnostics";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

function row(name: string) {
  return screen.getByRole("row", { name: new RegExp(name) });
}

const serverError = {
  error: {
    code: "internal_error",
    message: "Unhandled error",
    request_id: "req-500",
    details: [],
  },
};

beforeEach(async () => {
  await signInAs();
});

describe("SettingsDiagnostics loading", () => {
  it("shows skeletons for every card until the API answers", async () => {
    server.use(
      http.get("*/health", async () => {
        await delay("infinite");
        return HttpResponse.json({ status: "ok" });
      }),
      http.get("*/health/dependencies", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
      http.get("*/schemas/index.json", async () => {
        await delay("infinite");
        return HttpResponse.json({ schemas: [] });
      }),
    );
    renderWithProviders(<SettingsDiagnostics />);

    expect(screen.getByText("Checking the API")).toBeInTheDocument();
    expect(screen.getByText("Checking dependencies")).toBeInTheDocument();
    expect(screen.getByText("Loading the schema index")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(3);
  });
});

describe("SettingsDiagnostics with a healthy API", () => {
  it("shows liveness, every dependency and the published schemas", async () => {
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("The API is responding.")).toBeInTheDocument();
    expect(await screen.findByRole("row", { name: /Database/ })).toBeInTheDocument();

    expect(within(row("Database")).getByText("Up")).toBeInTheDocument();
    expect(within(row("Database")).getByText("3 ms")).toBeInTheDocument();
    expect(within(row("Temporal")).getByText("Up")).toBeInTheDocument();
    expect(within(row("Laya")).getByText("Up")).toBeInTheDocument();
    expect(within(row("Laya")).getByText("12 ms")).toBeInTheDocument();
    expect(within(row("Storage")).getByText("Unconfigured")).toBeInTheDocument();
    expect(within(row("Storage")).getByText("n/a")).toBeInTheDocument();
    expect(screen.queryByText(/dependenc(y|ies) (is|are) down/)).not.toBeInTheDocument();

    const bundle = await screen.findByRole("link", { name: "bundle.v1.json" });
    expect(bundle).toHaveAttribute("href", "http://localhost:8000/schemas/bundle.v1.json");
    expect(screen.getByRole("link", { name: "stream-event.v1.json" })).toBeInTheDocument();
  });

  it("names every card as a region", async () => {
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByRole("region", { name: "API" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dependencies" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Schemas" })).toBeInTheDocument();
  });
});

describe("SettingsDiagnostics with the dependencies_down fault", () => {
  it("marks the failing dependency down and raises an alert naming it", async () => {
    mockState.faults.apply({ dependencies_down: ["temporal"] });
    renderWithProviders(<SettingsDiagnostics />);

    const temporal = await screen.findByRole("row", { name: /Temporal/ });
    expect(within(temporal).getByText("Down")).toBeInTheDocument();
    expect(within(temporal).getByText("RuntimeError")).toBeInTheDocument();
    expect(within(row("Database")).getByText("Up")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("1 dependency is down");
    expect(alert).toHaveTextContent("Temporal");
  });

  it("counts several failing dependencies", async () => {
    mockState.faults.apply({ dependencies_down: true });
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("3 dependencies are down")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Database, Temporal, Laya");
  });

  it("keeps the API card healthy because liveness never depends on the dependencies", async () => {
    mockState.faults.apply({ dependencies_down: true });
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("The API is responding.")).toBeInTheDocument();
  });
});

describe("SettingsDiagnostics when one card fails", () => {
  it("shows a card-level error for the dependencies and recovers on retry", async () => {
    let failing = true;
    server.use(
      http.get("*/health/dependencies", () =>
        failing
          ? HttpResponse.json(serverError, { status: 500 })
          : HttpResponse.json({
              db: { status: "up", latency_ms: 4, detail: null },
              temporal: { status: "up", latency_ms: 6, detail: null },
              laya: { status: "up", latency_ms: 9, detail: null },
              storage: { status: "unconfigured", latency_ms: null, detail: null },
            }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("Dependency status unavailable")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-500")).toBeInTheDocument();
    expect(screen.getByText("The API is responding.")).toBeInTheDocument();

    failing = false;
    const dependencies = screen.getByRole("region", { name: "Dependencies" });
    await user.click(within(dependencies).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("row", { name: /Database/ })).toBeInTheDocument();
    expect(screen.queryByText("Dependency status unavailable")).not.toBeInTheDocument();
  });

  it("shows a card-level error for the schema index", async () => {
    server.use(
      http.get("*/schemas/index.json", () => HttpResponse.json(serverError, { status: 500 })),
    );
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("Schema index unavailable")).toBeInTheDocument();
    expect(await screen.findByRole("row", { name: /Database/ })).toBeInTheDocument();
  });

  it("says so when no schema is published", async () => {
    server.use(http.get("*/schemas/index.json", () => HttpResponse.json({ schemas: [] })));
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("The API has not published any schemas.")).toBeInTheDocument();
  });
});

describe("SettingsDiagnostics when the API is down", () => {
  it("replaces the cards with one error and a retry that brings them back", async () => {
    let reachable = false;
    server.use(
      http.get("*/health", () =>
        reachable ? HttpResponse.json({ status: "ok" }) : HttpResponse.error(),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("The API is not reachable")).toBeInTheDocument();
    expect(screen.getByText(/Cannot reach the Tessa API/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Dependencies" })).not.toBeInTheDocument();

    reachable = true;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("The API is responding.")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("The API is not reachable")).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole("row", { name: /Database/ })).toBeInTheDocument();
  });

  it("shows the API's request id when it answers with a server error", async () => {
    server.use(http.get("*/health", () => HttpResponse.json(serverError, { status: 500 })));
    renderWithProviders(<SettingsDiagnostics />);

    expect(await screen.findByText("The API is not reachable")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-500")).toBeInTheDocument();
  });
});
