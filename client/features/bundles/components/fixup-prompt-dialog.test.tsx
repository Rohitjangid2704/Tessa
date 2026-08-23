import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { signInAs } from "@/tests/utils/api-session";
import { GRACIE_ID, gracieVersion } from "@/tests/utils/bundles";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { FixupPromptDialog } = await import("./fixup-prompt-dialog");

function setup(overrides: Partial<Parameters<typeof FixupPromptDialog>[0]> = {}) {
  const { bundle } = gracieVersion(1);
  return renderWithProviders(
    <FixupPromptDialog
      targetId={GRACIE_ID}
      bundleId={bundle.id}
      bundleVersion={bundle.version}
      primary
      {...overrides}
    />,
  );
}

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("FixupPromptDialog", () => {
  it("is the primary action when the bundle needs fixing and secondary otherwise", () => {
    const first = setup({ primary: true });
    expect(screen.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "default",
    );
    first.unmount();

    setup({ primary: false });
    expect(screen.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "outline",
    );
  });

  it("issues the fix-up template for the bundle and opens the copy box with the text", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "Generate Fix-up prompt" }));

    const dialog = await screen.findByRole("dialog", { name: "Fix-up prompt for version 1" });
    const text = within(dialog).getByRole("textbox", { name: "Fix-up prompt text" });
    expect(text).toHaveAttribute("readonly");
    expect((text as HTMLTextAreaElement).value).toContain("completeness check");
    expect(within(dialog).getByRole("button", { name: "Copy Fix-up prompt" })).toBeInTheDocument();
    expect(
      within(dialog).getByText(/^\/tessa:discover tgt_/, { selector: "code" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Template fixup version \d+/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^tgt_/, { selector: "code" })).toBeInTheDocument();
    const [issued] = mockState.stageOne.promptIssues;
    expect(issued).toMatchObject({
      target_id: GRACIE_ID,
      template_name: "fixup",
      params: { template_name: "fixup", bundle_id: gracieVersion(1).bundle.id },
    });
    expect(mockState.stageOne.promptIssues).toHaveLength(1);
  });

  it("reopens the issued prompt without issuing another and can generate again", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Generate Fix-up prompt" }));
    const dialog = await screen.findByRole("dialog", { name: "Fix-up prompt for version 1" });

    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Show Fix-up prompt" }));
    const reopened = await screen.findByRole("dialog", { name: "Fix-up prompt for version 1" });
    expect(mockState.stageOne.promptIssues).toHaveLength(1);

    await user.click(within(reopened).getByRole("button", { name: "Generate again" }));

    await waitFor(() => expect(mockState.stageOne.promptIssues).toHaveLength(2));
  });

  it("reports a role problem instead of opening the dialog", async () => {
    await signInAs(VIEWER_USER);
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "Generate Fix-up prompt" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not generate the Fix-up prompt");
    expect(alert).toHaveTextContent("Your role cannot issue prompts");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Fix-up prompt" })).toBeEnabled();
  });

  it("is disabled with a visible reason", () => {
    setup({ disabledReason: "Viewers can read bundles but cannot generate prompts." });

    const button = screen.getByRole("button", { name: "Generate Fix-up prompt" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "Viewers can read bundles but cannot generate prompts.",
    );
  });

  it("is disabled without a reason while the role is still loading", () => {
    setup({ disabled: true });

    expect(screen.getByRole("button", { name: "Generate Fix-up prompt" })).toBeDisabled();
  });
});
