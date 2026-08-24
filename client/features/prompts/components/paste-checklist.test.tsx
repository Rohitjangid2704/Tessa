import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { CHECKLIST_STORAGE_PREFIX } from "../use-checklist-state";
import { COMPRESS_ARCHIVE_COMMAND, PasteChecklist } from "./paste-checklist";

const ISSUE = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11";
const OTHER_ISSUE = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e22";

beforeEach(() => {
  window.localStorage.clear();
});

describe("PasteChecklist", () => {
  it("lists the seven steps unticked with a progress count", () => {
    renderWithProviders(<PasteChecklist issueId={ISSUE} />);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(7);
    for (const box of boxes) {
      expect(box).not.toBeChecked();
    }
    expect(screen.getByText("0 of 7 steps done")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Open VS Code" })).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: "Wait until a Tessa/ folder appears in the project",
      }),
    ).toBeInTheDocument();
  });

  it("offers to run the prompt in Claude Code before the steps", () => {
    renderWithProviders(<PasteChecklist issueId={ISSUE} />);

    const link = screen.getByRole("link", { name: "run it in Claude Code" });
    expect(link).toHaveAttribute("href", "/settings/tokens");
    const firstBox = screen.getAllByRole("checkbox")[0] as HTMLElement;
    expect(link.compareDocumentPosition(firstBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("ticks a step, counts it and persists it for this issue", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PasteChecklist issueId={ISSUE} />);

    await user.click(screen.getByRole("checkbox", { name: "Open VS Code" }));
    await user.click(screen.getByRole("checkbox", { name: "Paste the prompt and send it" }));

    expect(screen.getByRole("checkbox", { name: "Open VS Code" })).toBeChecked();
    expect(screen.getByText("2 of 7 steps done")).toBeInTheDocument();
    expect(window.localStorage.getItem(`${CHECKLIST_STORAGE_PREFIX}${ISSUE}`)).toBe(
      '["open_vscode","paste_prompt"]',
    );
  });

  it("restores the ticks after a remount and not for another issue", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<PasteChecklist issueId={ISSUE} />);
    await user.click(screen.getByRole("checkbox", { name: "Zip the tessa/ folder" }));
    first.unmount();

    const again = renderWithProviders(<PasteChecklist issueId={ISSUE} />);
    expect(screen.getByRole("checkbox", { name: "Zip the tessa/ folder" })).toBeChecked();
    again.unmount();

    renderWithProviders(<PasteChecklist issueId={OTHER_ISSUE} />);
    expect(screen.getByRole("checkbox", { name: "Zip the tessa/ folder" })).not.toBeChecked();
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PasteChecklist issueId={ISSUE} />);

    const first = screen.getByRole("checkbox", { name: "Open VS Code" });
    await user.tab();
    expect(screen.getByRole("link", { name: "run it in Claude Code" })).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.keyboard(" ");

    expect(first).toBeChecked();
  });

  it("clears every tick with Reset", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PasteChecklist issueId={ISSUE} />);
    await user.click(screen.getByRole("checkbox", { name: "Open VS Code" }));
    await user.click(screen.getByRole("checkbox", { name: "Upload the zip on the Bundles tab" }));

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByText("0 of 7 steps done")).toBeInTheDocument();
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).not.toBeChecked();
    }
  });

  it("shows the Compress-Archive line and copies exactly that command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithProviders(<PasteChecklist issueId={ISSUE} />);

    const command = screen.getByRole("group", { name: "PowerShell command" });
    expect(within(command).getByText(COMPRESS_ARCHIVE_COMMAND)).toBeInTheDocument();
    expect(COMPRESS_ARCHIVE_COMMAND).toBe(
      "Compress-Archive -Path .\\tessa -DestinationPath .\\tessa.zip -Force",
    );

    await user.click(screen.getByRole("button", { name: "Copy zip command" }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith(COMPRESS_ARCHIVE_COMMAND);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
