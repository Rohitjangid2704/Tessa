import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { CURRENT_TARGET_STORAGE_KEY, rememberTarget } from "../current-target";
import { NewTargetWizard } from "./new-target-wizard";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const ERROR_BODY = (code: string, message: string, details: unknown[] = []) => ({
  error: { code, message, request_id: "req-4455667", details },
});

async function chooseAppKind(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: "App kind" }));
  await user.click(await screen.findByRole("option", { name: label }));
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, name = "Acme Shop") {
  await user.type(await screen.findByLabelText("Name"), name);
  await chooseAppKind(user, "Web app");
  await user.click(screen.getByRole("button", { name: "Create target" }));
}

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  await signInAs(MEMBER_USER);
});

describe("NewTargetWizard step 1", () => {
  it("shows the name and app kind form with step 1 current", async () => {
    renderWithProviders(<NewTargetWizard />);

    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "App kind" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Progress" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(within(steps).getByText("Name and app kind").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(within(steps).getByText("Discovery prompt").closest("li")).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.queryByText("Tier", { selector: "label" })).not.toBeInTheDocument();
  });

  it("lists the five app kinds", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);
    await screen.findByLabelText("Name");

    await user.click(screen.getByRole("combobox", { name: "App kind" }));

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Web app",
      "HTTP API",
      "LLM assistant",
      "Background worker",
      "Command line tool",
    ]);
  });

  it("validates before sending: a name and an app kind are required", async () => {
    let posts = 0;
    server.use(
      http.post("*/api/v1/targets", () => {
        posts += 1;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);
    await screen.findByLabelText("Name");

    await user.click(screen.getByRole("button", { name: "Create target" }));

    expect(await screen.findByText("Enter a name")).toBeInTheDocument();
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
      "Enter a name",
      "Choose an app kind",
    ]);
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(posts).toBe(0);
  });

  it("rejects a name over 120 characters", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);
    await user.click(await screen.findByLabelText("Name"));
    await user.paste("x".repeat(121));
    await chooseAppKind(user, "HTTP API");

    await user.click(screen.getByRole("button", { name: "Create target" }));

    expect(await screen.findByText("Use at most 120 characters")).toBeInTheDocument();
  });

  it("treats a name of spaces as empty", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);
    await user.type(await screen.findByLabelText("Name"), "   ");
    await chooseAppKind(user, "HTTP API");

    await user.click(screen.getByRole("button", { name: "Create target" }));

    expect(await screen.findByText("Enter a name")).toBeInTheDocument();
  });
});

describe("NewTargetWizard creating", () => {
  it("creates a QA target with a trimmed name and no tier, then moves to step 2", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post("*/api/v1/targets", async ({ request }) => {
        bodies.push(await request.clone().json());
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);

    await fillAndSubmit(user, "  Acme Shop  ");

    expect(await screen.findByText("Target created")).toBeInTheDocument();
    expect(bodies).toEqual([{ name: "Acme Shop", app_kind: "web" }]);
    expect(screen.queryByRole("form", { name: "New target" })).not.toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Progress" });
    expect(within(steps).getByText("Discovery prompt").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText("Acme Shop")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
  });

  it("shows the Discovery panel for the new target and a CTA to the bundle upload", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);

    await fillAndSubmit(user);

    expect(
      await screen.findByRole("heading", { level: 2, name: "Discovery prompt" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("checkbox", { name: "Describe the key browser flows" }),
    ).toBeChecked();
    const cta = screen.getByRole("link", { name: "Go to bundle upload" });
    expect(cta).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/targets\/[0-9a-f-]{36}\/bundles$/),
    );
    expect(screen.getByRole("link", { name: "Open the target page" })).toBeInTheDocument();
  });

  it("generates a prompt that carries the new target's token", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);
    await fillAndSubmit(user);

    await user.click(await screen.findByRole("button", { name: "Generate Discovery prompt" }));

    const text = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Discovery prompt",
    });
    expect(text.value).toMatch(/tgt_[A-Za-z0-9]{22}/);
    expect(text.value).toContain("bundle.v1.json");
  });

  it("remembers the new target as the current one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);

    await fillAndSubmit(user);

    await screen.findByText("Target created");
    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("makes the new target appear in the cached lists", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<NewTargetWizard />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await fillAndSubmit(user);

    await screen.findByText("Target created");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["targets", "list"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["targets", "options"] });
  });

  it("disables the button while the request is in flight so it cannot double submit", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    server.use(
      http.post("*/api/v1/targets", async () => {
        posts += 1;
        await gate;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);
    await user.type(await screen.findByLabelText("Name"), "Acme");
    await chooseAppKind(user, "Web app");

    await user.click(screen.getByRole("button", { name: "Create target" }));

    const pending = await screen.findByRole("button", { name: "Creating" });
    expect(pending).toBeDisabled();
    release();
    await screen.findByText("Target created");
    expect(posts).toBe(1);
  });
});

describe("NewTargetWizard server errors", () => {
  it("maps a 422 detail loc to its field", async () => {
    server.use(
      http.post("*/api/v1/targets", () =>
        HttpResponse.json(
          ERROR_BODY("validation_failed", "Request validation failed", [
            { loc: ["body", "name"], code: "string_too_short", message: "Name is already taken" },
          ]),
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);

    await fillAndSubmit(user);

    const message = await screen.findByText("Name is already taken");
    expect(message).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Could not create the target")).not.toBeInTheDocument();
    expect(screen.queryByText("Target created")).not.toBeInTheDocument();
  });

  it("maps several fields at once", async () => {
    server.use(
      http.post("*/api/v1/targets", () =>
        HttpResponse.json(
          ERROR_BODY("validation_failed", "Request validation failed", [
            { loc: ["body", "name"], code: "x", message: "Bad name" },
            { loc: ["body", "app_kind"], code: "enum", message: "Bad app kind" },
          ]),
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);

    await fillAndSubmit(user);

    expect(await screen.findByText("Bad name")).toBeInTheDocument();
    expect(screen.getByText("Bad app kind")).toBeInTheDocument();
  });

  it("shows a detail that maps to no field as a form message", async () => {
    server.use(
      http.post("*/api/v1/targets", () =>
        HttpResponse.json(
          ERROR_BODY("validation_failed", "Request validation failed", [
            { loc: ["body", "hints"], code: "type", message: "Hints are invalid" },
          ]),
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);

    await fillAndSubmit(user);

    const alert = await screen.findByText("Could not create the target");
    expect(alert.closest("[role=alert]")).toHaveTextContent("Hints are invalid");
  });

  it("clears the field error once the user fixes the value and resubmits", async () => {
    let attempts = 0;
    server.use(
      http.post("*/api/v1/targets", () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json(
              ERROR_BODY("validation_failed", "Request validation failed", [
                { loc: ["body", "name"], code: "x", message: "Name is already taken" },
              ]),
              { status: 422 },
            )
          : undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);
    await fillAndSubmit(user);
    await screen.findByText("Name is already taken");

    await user.type(screen.getByLabelText("Name"), " 2");
    await user.click(screen.getByRole("button", { name: "Create target" }));

    expect(await screen.findByText("Target created")).toBeInTheDocument();
  });

  it("shows a server failure as a form message with the request id", async () => {
    server.use(
      http.post("*/api/v1/targets", () =>
        HttpResponse.json(ERROR_BODY("internal_error", "Unhandled error"), { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewTargetWizard />);

    await fillAndSubmit(user);

    const alert = await screen.findByText("Could not create the target");
    expect(alert.closest("[role=alert]")).toHaveTextContent("Unhandled error");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create target" })).toBeEnabled(),
    );
  });
});

describe("NewTargetWizard role gating", () => {
  it("blocks a viewer with an explanation and no form", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<NewTargetWizard />);

    expect(await screen.findByText("You cannot create targets")).toBeInTheDocument();
    expect(screen.getByText(/needs the member or admin role/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "targets list" })).toHaveAttribute("href", "/targets");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("shows a loading state until the role is known", async () => {
    renderWithProviders(<NewTargetWizard />);

    expect(screen.getByText("Checking your role")).toBeInTheDocument();
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  });
});
