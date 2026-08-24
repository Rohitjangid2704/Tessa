import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { fixedToken, STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import type { PromptIssue } from "../types";
import { CHECKLIST_STORAGE_PREFIX } from "../use-checklist-state";
import { DiscoveryPromptPanel, initialHintSelection } from "./discovery-prompt-panel";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const GRACIE_TARGET = {
  id: STAGE_ONE_IDS.gracie,
  name: "Gracie",
  app_kind: "llm_assistant",
  archived_at: null,
  target_token: fixedToken("graciedemotoken"),
} as const;

const BILLING_TARGET = {
  id: STAGE_ONE_IDS.billing,
  name: "Billing API",
  app_kind: "api",
  archived_at: null,
  target_token: fixedToken("billingapitoken"),
} as const;

const ERROR_BODY = (code: string, message: string, details: unknown[] = []) => ({
  error: { code, message, request_id: "req-9876543", details },
});

function generateButton() {
  return screen.findByRole("button", { name: /Generate/ });
}

beforeEach(async () => {
  window.localStorage.clear();
  await signInAs(MEMBER_USER);
});

describe("initialHintSelection", () => {
  const hints = [
    { id: "a", label: "A", default_on: true },
    { id: "b", label: "B", default_on: false },
  ];

  it("starts from the default_on hints without an issue", () => {
    expect(initialHintSelection(hints, null)).toEqual(new Set(["a"]));
  });

  it("starts from the hints of an earlier Discovery issue and drops unknown ones", () => {
    const issue = {
      template_name: "discovery",
      params: { template_name: "discovery", hint_ids: ["b", "gone"] },
    } as unknown as PromptIssue;

    expect(initialHintSelection(hints, issue)).toEqual(new Set(["b"]));
  });
});

describe("DiscoveryPromptPanel hints", () => {
  it("lists the hints of the app kind with the default_on ones ticked", async () => {
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);

    const tools = await screen.findByRole("checkbox", {
      name: "List the tools the assistant can call",
    });
    expect(tools).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /confirmation gate/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /transcript and trace/ })).toBeChecked();
  });

  it("leaves a hint that is not default_on unticked", async () => {
    renderWithProviders(<DiscoveryPromptPanel target={BILLING_TARGET} />);

    expect(
      await screen.findByRole("checkbox", { name: "Include the OpenAPI schema" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Record rate limits and idempotency rules" }),
    ).not.toBeChecked();
  });

  it("shows a skeleton while the hints load and an error with retry when they fail", async () => {
    server.use(
      http.get(
        "*/api/v1/app-kinds",
        () => HttpResponse.json(ERROR_BODY("internal_error", "Boom"), { status: 500 }),
        {
          once: true,
        },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);

    expect(screen.getByText("Loading the app-kind hints")).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("req-9876543");
    expect(await generateButton()).toBeDisabled();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("checkbox", { name: "List the tools the assistant can call" }),
    ).toBeInTheDocument();
  });
});

describe("DiscoveryPromptPanel generate", () => {
  it("issues the prompt and shows its text, token, template version and time", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await screen.findByRole("checkbox", { name: /tools/ });

    await user.click(await generateButton());

    const text = await screen.findByRole("textbox", { name: "Discovery prompt" });
    const prompt = (text as HTMLTextAreaElement).value;
    expect(prompt).toContain(GRACIE_TARGET.target_token);
    expect(prompt).toContain("http://localhost:8000/schemas/bundle.v1.json");
    expect(prompt).toContain("List every tool the assistant can call");
    expect(screen.getByText("Discovery v2")).toBeInTheDocument();
    expect(screen.getAllByText(GRACIE_TARGET.target_token)[0]).toBeInTheDocument();
    expect(document.querySelector("dl time")).toHaveAttribute("datetime");
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate again" })).toBeInTheDocument();
  });

  it("puts the Claude Code command for the target token beside the copy button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await screen.findByRole("checkbox", { name: /tools/ });

    await user.click(await generateButton());

    await screen.findByRole("textbox", { name: "Discovery prompt" });
    const chip = screen.getByRole("group", { name: "Claude Code command" });
    expect(
      within(chip).getByText(`/tessa:discover ${GRACIE_TARGET.target_token}`),
    ).toBeInTheDocument();
    expect(
      within(chip).getByRole("button", { name: "Copy Claude Code command" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeInTheDocument();
  });

  it("sends only the ticked hints", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await user.click(await screen.findByRole("checkbox", { name: /confirmation gate/ }));

    await user.click(await generateButton());

    const text = (await screen.findByRole("textbox", {
      name: "Discovery prompt",
    })) as HTMLTextAreaElement;
    expect(text.value).toContain("List every tool the assistant can call");
    expect(text.value).not.toContain("Describe the confirmation gate");
  });

  it("shows the paste checklist for the issued prompt and keeps its ticks per issue", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await user.click(await generateButton());

    await user.click(await screen.findByRole("checkbox", { name: "Open VS Code" }));

    const keys = Object.keys(window.localStorage).filter((key) =>
      key.startsWith(CHECKLIST_STORAGE_PREFIX),
    );
    expect(keys).toHaveLength(1);
    expect(screen.getByText("1 of 7 steps done")).toBeInTheDocument();
  });

  it("generates a fresh issue with its own checklist when asked again", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await user.click(await generateButton());
    await user.click(await screen.findByRole("checkbox", { name: "Open VS Code" }));

    await user.click(await screen.findByRole("button", { name: "Generate again" }));

    await waitFor(() => expect(screen.getByText("0 of 7 steps done")).toBeInTheDocument());
  });

  it("reuses the idempotency key for a retry and renews it after a change or a success", async () => {
    const keys: Array<string | null> = [];
    let attempts = 0;
    server.use(
      http.post("*/api/v1/targets/:target_id/prompt-issues", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json(ERROR_BODY("internal_error", "Boom"), { status: 500 })
          : undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await screen.findByRole("checkbox", { name: /tools/ });

    await user.click(await generateButton());
    await screen.findByText("Could not generate the prompt");
    await user.click(await generateButton());
    await screen.findByRole("textbox", { name: "Discovery prompt" });
    await user.click(await screen.findByRole("button", { name: "Generate again" }));
    await waitFor(() => expect(keys).toHaveLength(3));

    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("disables Generate and shows Generating while the request is pending", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post("*/api/v1/targets/:target_id/prompt-issues", async () => {
        await gate;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await screen.findByRole("checkbox", { name: /tools/ });

    await user.click(await generateButton());

    expect(await screen.findByRole("button", { name: "Generating" })).toBeDisabled();
    expect(screen.getByText("Generating the prompt")).toBeInTheDocument();
    release();
    await screen.findByRole("textbox", { name: "Discovery prompt" });
  });
});

describe("DiscoveryPromptPanel errors", () => {
  it("explains an unknown hint (422 unknown_hint) and offers to reload the hints", async () => {
    server.use(
      http.post(
        "*/api/v1/targets/:target_id/prompt-issues",
        () =>
          HttpResponse.json(
            ERROR_BODY("validation_failed", "Request validation failed", [
              {
                loc: ["body", "hint_ids", 0],
                code: "unknown_hint",
                message: "Unknown hint 'x'",
              },
            ]),
            { status: 422 },
          ),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await screen.findByRole("checkbox", { name: /tools/ });

    await user.click(await generateButton());

    const alert = await screen.findByText(/does not exist for this app kind/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-9876543")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload hints" }));
    await waitFor(() =>
      expect(screen.queryByText(/does not exist for this app kind/)).not.toBeInTheDocument(),
    );
  });

  it("explains an archived target answered with 409", async () => {
    server.use(
      http.post("*/api/v1/targets/:target_id/prompt-issues", () =>
        HttpResponse.json(ERROR_BODY("conflict", "The target is archived"), { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await screen.findByRole("checkbox", { name: /tools/ });

    await user.click(await generateButton());

    expect(
      await screen.findByText("This target is archived, so it cannot issue new prompts."),
    ).toBeInTheDocument();
  });

  it("explains a 403 from the API even if the UI let the click through", async () => {
    server.use(
      http.post("*/api/v1/targets/:target_id/prompt-issues", () =>
        HttpResponse.json(ERROR_BODY("role_required", "Member role required"), { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);
    await screen.findByRole("checkbox", { name: /tools/ });

    await user.click(await generateButton());

    expect(
      await screen.findByText("Your role cannot issue prompts. Ask a member or an admin."),
    ).toBeInTheDocument();
  });
});

describe("DiscoveryPromptPanel gating", () => {
  it("lets a viewer read hints but not generate", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} />);

    expect(
      await screen.findByText(/issuing one needs the member or admin role/),
    ).toBeInTheDocument();
    expect(await generateButton()).toBeDisabled();
    expect(
      await screen.findByRole("checkbox", { name: "List the tools the assistant can call" }),
    ).toBeDisabled();
  });

  it("blocks generating for an archived target", async () => {
    renderWithProviders(
      <DiscoveryPromptPanel
        target={{ ...GRACIE_TARGET, archived_at: "2026-09-20T08:00:00.000Z" }}
      />,
    );

    expect(await screen.findByText(/This target is archived/)).toBeInTheDocument();
    expect(await generateButton()).toBeDisabled();
  });
});

describe("DiscoveryPromptPanel with an earlier issue", () => {
  const earlier = {
    id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b7001",
    target_id: GRACIE_TARGET.id,
    template_name: "discovery",
    template_version: 1,
    target_token: GRACIE_TARGET.target_token,
    text: "Earlier discovery prompt for tgt",
    params: { template_name: "discovery", hint_ids: ["list_tools"] },
    issued_by: MEMBER_USER.id,
    issued_at: "2026-09-11T10:00:00.000Z",
  } satisfies PromptIssue;

  it("shows the earlier prompt and starts from the hints it used", async () => {
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} initialIssue={earlier} />);

    expect(await screen.findByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
      "Earlier discovery prompt for tgt",
    );
    expect(screen.getByText("Discovery v1")).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: /tools/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /confirmation gate/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Generate again" })).toBeInTheDocument();
  });

  it("warns when the token was rotated after the prompt was issued", async () => {
    renderWithProviders(
      <DiscoveryPromptPanel
        target={{ ...GRACIE_TARGET, target_token: fixedToken("rotatedtoken") }}
        initialIssue={earlier}
      />,
    );

    expect(await screen.findByText(/The target token was rotated/)).toBeInTheDocument();
  });

  it("does not warn when the token still matches", async () => {
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} initialIssue={earlier} />);

    await screen.findByRole("textbox", { name: "Discovery prompt" });
    expect(screen.queryByText(/The target token was rotated/)).not.toBeInTheDocument();
  });

  it("opens the template viewer for the version that produced the prompt", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryPromptPanel target={GRACIE_TARGET} initialIssue={earlier} />);

    await user.click(await screen.findByRole("button", { name: "View template v1" }));

    const dialog = await screen.findByRole("dialog", { name: "Discovery template" });
    const text = await within(dialog).findByRole<HTMLTextAreaElement>("textbox", {
      name: "Template text",
    });
    expect(text.value).toContain("{{TARGET_TOKEN}}");
    expect(text.value).not.toContain("Format conventions");
  });
});
