import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPromptIssue } from "@/mocks/factories/prompts";
import { mockState } from "@/mocks/handlers";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { fixedToken, STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import { LatestBundleCard } from "./latest-bundle-card";
import { TargetOverview } from "./target-overview";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const { gracie, billing, brokenImport } = STAGE_ONE_IDS;

beforeEach(async () => {
  window.localStorage.clear();
  await signInAs(MEMBER_USER);
});

describe("LatestBundleCard", () => {
  it("shows the newest version with validity, bar status, score and features", async () => {
    renderWithProviders(<LatestBundleCard targetId={gracie} />);

    expect(await screen.findByText("Version 2")).toBeInTheDocument();
    expect(screen.getByText("Valid")).toBeInTheDocument();
    expect(screen.getByText("Meets bar")).toBeInTheDocument();
    expect(screen.getByText("92 / 100")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "Open bundle" });
    expect(open).toHaveAttribute(
      "href",
      expect.stringMatching(new RegExp(`^/targets/${gracie}/bundles/[0-9a-f-]{36}$`)),
    );
    expect(screen.getByRole("link", { name: "All versions" })).toHaveAttribute(
      "href",
      `/targets/${gracie}/bundles`,
    );
  });

  it("shows invalid for a bundle that failed validation", async () => {
    renderWithProviders(<LatestBundleCard targetId={brokenImport} />);

    expect(await screen.findByText("Invalid")).toBeInTheDocument();
    expect(screen.getByText("Below bar")).toBeInTheDocument();
  });

  it("invites the first upload when there is no bundle", async () => {
    renderWithProviders(<LatestBundleCard targetId={billing} />);

    expect(await screen.findByText(/No bundle yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload a bundle" })).toHaveAttribute(
      "href",
      `/targets/${billing}/bundles`,
    );
  });
});

describe("TargetOverview", () => {
  it("composes the Discovery panel, history, latest bundle, token, settings and danger zone", async () => {
    await signInAs(MEMBER_USER);
    renderWithProviders(<TargetOverview targetId={gracie} />);

    expect(
      await screen.findByRole("heading", { level: 2, name: "Discovery prompt" }),
    ).toBeInTheDocument();
    for (const name of ["Prompt history", "Latest bundle", "Target token", "Settings"]) {
      expect(await screen.findByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByText(fixedToken("graciedemotoken"))).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Danger zone" })).not.toBeInTheDocument();
  });

  it("reopens the latest Discovery prompt with its checklist", async () => {
    mockState.stageOne.promptIssues.push(
      buildPromptIssue({
        id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b0001",
        target_id: gracie,
        target_token: fixedToken("graciedemotoken"),
        text: "Earlier discovery prompt text",
        params: { template_name: "discovery", hint_ids: ["list_tools"] },
      }),
    );
    renderWithProviders(<TargetOverview targetId={gracie} />);

    expect(await screen.findByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
      "Earlier discovery prompt text",
    );
    expect(screen.getByRole("heading", { name: "Paste checklist" })).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: /tools/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /confirmation gate/ })).not.toBeChecked();
  });

  it("lists the reopened prompt in the history too", async () => {
    mockState.stageOne.promptIssues.push(
      buildPromptIssue({ target_id: gracie, text: "Earlier discovery prompt text" }),
    );
    renderWithProviders(<TargetOverview targetId={gracie} />);

    await screen.findByText("Showing 1 of 1 prompt");
    const history = screen.getByRole("table", { name: "Prompt history" });
    expect(within(history).getAllByRole("row")).toHaveLength(2);
  });

  it("is read-only for a viewer: nothing to generate, rotate, rename or archive", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<TargetOverview targetId={gracie} />);

    expect(
      await screen.findByText(/issuing one needs the member or admin role/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Renaming it needs the member or admin role/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive target" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Discovery prompt" })).toBeDisabled();
  });
});
