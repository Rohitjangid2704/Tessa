import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockState } from "@/mocks/handlers";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { environmentRevision, describeSaved, EnvironmentView } from "./environment-view";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { gracie, billing } = STAGE_ONE_IDS;
const DSN = "postgresql://qa_reader:dev-only-typed-secret-77@db.qa.example.test:5432/gracie";
const TYPED_SECRET = "dev-only-typed-secret-77";

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

let recorded: RecordedRequest[] = [];

function record(): void {
  recorded = [];
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1/targets/") && request.method !== "GET") {
      void request
        .clone()
        .text()
        .then((body) => recorded.push({ method: request.method, path: url.pathname, body }));
    }
  });
}

afterEach(() => {
  server.events.removeAllListeners();
});

beforeEach(async () => {
  recorded = [];
  await signInAs(MEMBER_USER);
});

function field(name: string): HTMLElement {
  return document.querySelector(`[data-variable="${name}"]`) as HTMLElement;
}

function input(name: string): HTMLInputElement {
  return within(field(name)).getByLabelText(name) as HTMLInputElement;
}

async function loaded(): Promise<void> {
  await screen.findByRole("form", { name: "Environment variables" });
}

async function pasteInto(
  user: ReturnType<typeof userEvent.setup>,
  element: HTMLElement,
  value: string,
): Promise<void> {
  await user.click(element);
  await user.paste(value);
}

const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const runButton = () => screen.getByRole("button", { name: /^Run health checks$/ });

async function stored(): Promise<void> {
  await screen.findByRole("list", { name: "Interface health" });
}

describe("EnvironmentView loading the page", () => {
  it("shows a loading state and then the variables, the banner and the stored health", async () => {
    renderWithProviders(<EnvironmentView targetId={gracie} />);

    expect(screen.getByText("Loading the environment")).toBeInTheDocument();
    await loaded();
    await stored();

    expect(screen.getByRole("heading", { level: 2, name: "Variables" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Health checks" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-slot=env-variable-field]")).toHaveLength(12);
    const banner = document.querySelector("[data-slot=missing-required-banner]") as HTMLElement;
    expect(banner).toHaveTextContent("1 required variable has no value");
    expect(banner).toHaveTextContent("GRACIE_READONLY_DSN");
  });

  it("shows the stored health report with a failed and a skipped tick", async () => {
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await stored();

    const strip = document.querySelector("[data-slot=health-strip]") as HTMLElement;
    expect(strip).toHaveTextContent("Last checked");
    expect(within(strip).getByText("Connection refused or host unreachable")).toBeInTheDocument();
    expect(
      (strip.querySelector('[data-interface="events_sse"]') as HTMLElement).dataset.status,
    ).toBe("failed");
    expect(
      (strip.querySelector('[data-interface="ops_webhook"]') as HTMLElement).dataset.status,
    ).toBe("skipped");
    expect((strip.querySelector('[data-interface="rest_api"]') as HTMLElement).dataset.status).toBe(
      "ok",
    );
  });

  it("flags the stale variables apart from the declared ones", async () => {
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    const staleSection = screen.getByRole("region", { name: "Not used by the latest bundle" });
    expect(within(staleSection).getByText("GRACIE_LEGACY_API_KEY")).toBeInTheDocument();
    expect(within(staleSection).getByText("GRACIE_STAGING_URL")).toBeInTheDocument();
    expect(within(staleSection).getAllByText("Stale")).toHaveLength(2);
    expect(within(field("GRACIE_API_URL")).queryByText("Stale")).not.toBeInTheDocument();
  });

  it("shows the empty state with a way to the intake page for a target without a bundle", async () => {
    renderWithProviders(<EnvironmentView targetId={billing} />);

    expect(await screen.findByRole("heading", { name: "No variables yet" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Upload a bundle" })[0]).toHaveAttribute(
      "href",
      `/targets/${billing}/bundles`,
    );
    expect(await screen.findByText("No health check has run yet.")).toBeInTheDocument();
  });

  it("shows an error with a retry when the environment cannot be loaded", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(
        "*/api/v1/targets/:id/environment",
        () =>
          HttpResponse.json(
            {
              error: {
                code: "internal_error",
                message: "Boom",
                request_id: "req-env-500",
                details: [],
              },
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    renderWithProviders(<EnvironmentView targetId={gracie} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the environment");
    expect(screen.getByText("Request ID: req-env-500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await loaded();
  });
});

describe("EnvironmentView saving", () => {
  it("saves only what changed, clears the typed secret and drops the missing-required banner", async () => {
    const user = userEvent.setup();
    record();
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    await pasteInto(user, input("GRACIE_READONLY_DSN"), DSN);
    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText("Saved: 1 value set.")).toBeInTheDocument());
    const patch = recorded.find((request) => request.method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({
      set: { GRACIE_READONLY_DSN: DSN },
      clear: [],
    });
    expect(document.querySelector("[data-slot=missing-required-banner]")).not.toBeInTheDocument();
    expect(within(field("GRACIE_READONLY_DSN")).getByText("Set")).toBeInTheDocument();
    expect(input("GRACIE_READONLY_DSN")).toHaveValue("");
    expect(saveButton()).toBeDisabled();
  });

  it("never leaves the typed secret in the page or in the mutation cache", async () => {
    const user = userEvent.setup();
    const { queryClient, container } = renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    await pasteInto(user, input("GRACIE_READONLY_DSN"), DSN);
    await user.click(saveButton());
    await screen.findByText("Saved: 1 value set.");

    expect(container.textContent).not.toContain(TYPED_SECRET);
    expect(container.innerHTML).not.toContain(TYPED_SECRET);
    for (const element of container.querySelectorAll("input")) {
      expect(element.value).not.toContain(TYPED_SECRET);
    }
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(TYPED_SECRET);
  });

  it("clears a mutation holding a secret even when the save fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.patch("*/api/v1/targets/:id/environment", () =>
        HttpResponse.json(
          {
            error: {
              code: "internal_error",
              message: "Boom",
              request_id: "req-save-500",
              details: [],
            },
          },
          { status: 500 },
        ),
      ),
    );
    const { queryClient } = renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    await pasteInto(user, input("GRACIE_READONLY_DSN"), DSN);
    await user.click(saveButton());

    expect(await screen.findByText("Could not save the environment")).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
    expect(input("GRACIE_READONLY_DSN")).toHaveValue(DSN);
    expect(saveButton()).toBeEnabled();
  });

  it("clears a stored value and reports it", async () => {
    const user = userEvent.setup();
    record();
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    await user.click(
      within(field("GRACIE_ADMIN_TOKEN")).getByRole("button", {
        name: "Clear stored value of GRACIE_ADMIN_TOKEN",
      }),
    );
    await user.click(saveButton());

    await screen.findByText("Saved: 1 value cleared.");
    expect(
      JSON.parse(recorded.find((request) => request.method === "PATCH")?.body ?? "{}"),
    ).toEqual({
      set: {},
      clear: ["GRACIE_ADMIN_TOKEN"],
    });
    expect(within(field("GRACIE_ADMIN_TOKEN")).getByText("Not set")).toBeInTheDocument();
    expect(
      await screen.findByText("2 required variables have no value", { exact: false }),
    ).toBeInTheDocument();
  });

  it("puts a server 422 on the variable it names and keeps what was typed", async () => {
    const user = userEvent.setup();
    server.use(
      http.patch("*/api/v1/targets/:id/environment", () =>
        HttpResponse.json(
          {
            error: {
              code: "validation_failed",
              message: "Request validation failed",
              request_id: "req-422",
              details: [
                {
                  loc: ["body", "set", "GRACIE_READONLY_DSN"],
                  code: "invalid_value",
                  message: "A dsn variable needs a value like scheme://host",
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    await pasteInto(user, input("GRACIE_READONLY_DSN"), DSN);
    await user.click(saveButton());

    expect(
      await within(field("GRACIE_READONLY_DSN")).findByText(
        "A dsn variable needs a value like scheme://host",
      ),
    ).toBeInTheDocument();
    expect(input("GRACIE_READONLY_DSN")).toHaveValue(DSN);
    expect(screen.queryByText("Could not save the environment")).not.toBeInTheDocument();
  });

  it("does not call the API when a typed value is invalid", async () => {
    const user = userEvent.setup();
    record();
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    await user.type(input("GRACIE_READONLY_DSN"), "not a dsn");
    await user.click(saveButton());

    expect(await screen.findByText("Enter a DSN like scheme://host")).toBeInTheDocument();
    expect(recorded.filter((request) => request.method === "PATCH")).toEqual([]);
  });
});

describe("EnvironmentView read-only access", () => {
  it("shows a viewer the values and the health but no way to change or run anything", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();
    await stored();

    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/read-only access/).length).toBeGreaterThan(0);
    expect(input("GRACIE_API_URL")).toHaveAttribute("readonly");
    expect(input("GRACIE_API_URL")).toHaveValue("https://gracie-api.qa.example.test");
    expect(runButton()).toBeDisabled();
  });

  it("makes the environment of an archived target read-only for a member", async () => {
    const target = mockState.stageOne.findTarget(gracie);
    if (target === undefined) {
      throw new Error("seeded target missing");
    }
    target.archivedAt = "2026-09-30T08:00:00.000Z";
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();
    await stored();

    expect(screen.getAllByText(/This target is archived/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(runButton()).toBeDisabled();
  });
});

describe("EnvironmentView health checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows indeterminate progress while the checks run and then replaces the strip", async () => {
    const user = userEvent.setup();
    mockState.faults.apply({ health_slow: 400 });
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await stored();

    await user.click(runButton());

    expect(
      await screen.findByRole("progressbar", { name: "Running health checks" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running health checks" })).toBeDisabled();
    expect(document.querySelector("[data-slot=health-strip]")).toHaveAttribute("aria-busy", "true");
    await waitFor(() =>
      expect(
        screen.queryByRole("progressbar", { name: "Running health checks" }),
      ).not.toBeInTheDocument(),
    );
    expect(document.querySelector("[data-slot=health-strip]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });

  it("renders ok, failed and skipped ticks with their messages after a run", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await stored();

    await user.click(runButton());

    await waitFor(() =>
      expect(document.querySelector('[data-interface="truth:gracie_db"]')).toHaveAttribute(
        "data-status",
        "skipped",
      ),
    );
    const strip = document.querySelector("[data-slot=health-strip]") as HTMLElement;
    expect(within(strip).getByText("Connection refused or host unreachable")).toBeInTheDocument();
    expect(within(strip).getByText("No value set for GRACIE_READONLY_DSN")).toBeInTheDocument();
    expect(
      within(strip).getByText("Interface kind webhook is not checked yet"),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("[data-slot=health-row]")).toHaveLength(6);
    expect(
      screen.getByText(/Health checks finished: 3 ok, 1 failed, 2 skipped/),
    ).toBeInTheDocument();
  });

  it("shows the health of each variable after a run", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    await user.click(runButton());

    await waitFor(() =>
      expect(within(field("GRACIE_EVENTS_URL")).getByText("Failed")).toBeInTheDocument(),
    );
    expect(within(field("GRACIE_API_URL")).getByText("OK")).toBeInTheDocument();
  });

  it("checks the value that was just saved", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();
    await pasteInto(user, input("GRACIE_READONLY_DSN"), DSN);
    await user.click(saveButton());
    await screen.findByText("Saved: 1 value set.");

    await user.click(runButton());

    await waitFor(() =>
      expect(document.querySelector('[data-interface="truth:gracie_db"]')).toHaveAttribute(
        "data-status",
        "ok",
      ),
    );
  });

  it("sends the request with a 60 second timeout signal", async () => {
    const user = userEvent.setup();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await stored();

    await user.click(runButton());

    await waitFor(() => expect(timeout).toHaveBeenCalledWith(60_000));
  });

  it("reports a timeout and keeps the last stored result", async () => {
    const user = userEvent.setup();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new DOMException("The operation timed out", "TimeoutError")),
    );
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await stored();

    await user.click(runButton());

    const failure = await screen.findByText("Health checks timed out");
    expect(failure).toBeInTheDocument();
    expect(screen.getByText(/60 s/)).toBeInTheDocument();
    expect(document.querySelector('[data-interface="events_sse"]')).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it("sends a target without a valid bundle to the intake page", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EnvironmentView targetId={billing} />);
    await screen.findByText("No health check has run yet.");

    await user.click(runButton());

    const alert = await screen.findByText("No valid bundle yet");
    const failure = alert.closest("[data-slot=health-failure]") as HTMLElement;
    expect(within(failure).getByRole("link", { name: "Upload a bundle" })).toHaveAttribute(
      "href",
      `/targets/${billing}/bundles`,
    );
  });

  it("shows an inline error with a retry when the stored result cannot be loaded", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(
        "*/api/v1/targets/:id/health",
        () =>
          HttpResponse.json(
            {
              error: {
                code: "internal_error",
                message: "Boom",
                request_id: "req-health-500",
                details: [],
              },
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    renderWithProviders(<EnvironmentView targetId={gracie} />);
    await loaded();

    expect(await screen.findByText("Could not load the last health check")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Environment variables" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await stored();
  });
});

describe("environmentRevision and describeSaved", () => {
  it("changes when a value is set or cleared but not when only the health changes", () => {
    const base = mockState.stageOne.environmentOf(gracie).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      secret: entry.secret,
      required: entry.required,
      purpose: entry.purpose,
      interface_ids: entry.interface_ids,
      has_value: entry.value !== null,
      value: entry.secret ? null : entry.value,
      stale: entry.stale,
      last_set_at: entry.last_set_at,
      last_set_by: entry.last_set_by,
      health: entry.health,
    }));
    const [first] = base;
    if (first === undefined) {
      throw new Error("no variables");
    }
    const withHealth = [
      { ...first, health: { ...first.health, status: "ok" as const } },
      ...base.slice(1),
    ];
    const withValue = [{ ...first, has_value: !first.has_value }, ...base.slice(1)];

    expect(environmentRevision(withHealth)).toBe(environmentRevision(base));
    expect(environmentRevision(withValue)).not.toBe(environmentRevision(base));
  });

  it("summarises a save without naming any value", () => {
    expect(describeSaved({ set: { A: "x", B: "y" }, clear: ["C"] })).toBe(
      "Saved: 2 values set, 1 value cleared.",
    );
    expect(describeSaved({ set: { A: "x" }, clear: [] })).toBe("Saved: 1 value set.");
    expect(describeSaved({ set: {}, clear: ["A", "B"] })).toBe("Saved: 2 values cleared.");
  });
});
