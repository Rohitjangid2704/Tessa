import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPromptIssue } from "@/mocks/factories/prompts";
import { mockState } from "@/mocks/handlers";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { PromptHistory } from "./prompt-history";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { gracie } = STAGE_ONE_IDS;

function addIssue(index: number, overrides: Parameters<typeof buildPromptIssue>[0] = {}) {
  mockState.stageOne.promptIssues.push(
    buildPromptIssue({
      id: `0198f6f2-4c2a-7d10-9c1e-6a4f0d3b${String(index).padStart(4, "0")}`,
      target_id: gracie,
      template_name: "discovery",
      template_version: 2,
      text: `Prompt text number ${index}`,
      issued_at: new Date(Date.UTC(2026, 8, 11, 10, index)).toISOString(),
      ...overrides,
    }),
  );
}

function table() {
  return screen.getByRole("table", { name: "Prompt history" });
}

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("PromptHistory", () => {
  it("explains that nothing has been issued yet", async () => {
    renderWithProviders(<PromptHistory targetId={gracie} />);

    expect(
      await screen.findByRole("heading", { name: "No prompts issued yet" }),
    ).toBeInTheDocument();
  });

  it("lists issued prompts newest first with template, version and time", async () => {
    addIssue(1);
    addIssue(2, { template_name: "fixup", template_version: 1 });
    renderWithProviders(<PromptHistory targetId={gracie} />);

    await screen.findByText("Showing 2 of 2 prompts");
    const rows = within(table()).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Fix-up v1",
      "Discovery v2",
    ]);
    expect(rows[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-09-11T10:02:00.000Z");
  });

  it("only lists the prompts of this target", async () => {
    addIssue(1);
    addIssue(2, { target_id: STAGE_ONE_IDS.billing });
    renderWithProviders(<PromptHistory targetId={gracie} />);

    await screen.findByText("Showing 1 of 1 prompt");
  });

  it("reopens a prompt in a dialog with its exact text and the template that produced it", async () => {
    addIssue(1, { template_version: 1 });
    const user = userEvent.setup();
    renderWithProviders(<PromptHistory targetId={gracie} />);

    await user.click(await screen.findByRole("button", { name: "Open Discovery v1 prompt" }));

    const dialog = await screen.findByRole("dialog", { name: "Discovery prompt" });
    expect(await within(dialog).findByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
      "Prompt text number 1",
    );
    expect(within(dialog).getByText("Discovery v1")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy prompt" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "View template v1" })).toBeInTheDocument();
  });

  it("shows an error with a retry when the prompt cannot be reopened", async () => {
    addIssue(1);
    server.use(
      http.get(
        "*/api/v1/prompt-issues/:id",
        () =>
          HttpResponse.json(
            { error: { code: "not_found", message: "gone", request_id: "req-1", details: [] } },
            { status: 404 },
          ),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<PromptHistory targetId={gracie} />);
    await user.click(await screen.findByRole("button", { name: "Open Discovery v2 prompt" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the prompt");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
      "Prompt text number 1",
    );
  });

  it("pages through a long history with Load more", async () => {
    for (let index = 1; index <= 12; index += 1) {
      addIssue(index);
    }
    const user = userEvent.setup();
    renderWithProviders(<PromptHistory targetId={gracie} />);

    await screen.findByText("Showing 10 of 12 prompts");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await screen.findByText("Showing 12 of 12 prompts");
  });

  it("shows an error with a retry when the history fails to load", async () => {
    server.use(
      http.get(
        "*/api/v1/targets/:target_id/prompt-issues",
        () =>
          HttpResponse.json(
            { error: { code: "internal_error", message: "x", request_id: "req-2", details: [] } },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<PromptHistory targetId={gracie} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("req-2");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "No prompts issued yet" }),
    ).toBeInTheDocument();
  });
});
