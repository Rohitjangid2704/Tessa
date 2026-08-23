import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/tests/utils/render";
import { MAX_AUTHOR_CELL_IDS } from "../use-claude-code-command";
import { CLAUDE_CODE_COMMAND_HINT, ClaudeCodeCommand } from "./claude-code-command";

describe("ClaudeCodeCommand", () => {
  it("shows the command in monospace beside a copy button", () => {
    renderWithProviders(
      <ClaudeCodeCommand template="explain" params={{ finding_id: "finding-1" }} />,
    );

    const code = screen.getByText("/tessa:explain finding-1");
    expect(code.tagName).toBe("CODE");
    expect(code).toHaveClass("font-mono");
    expect(screen.getByRole("button", { name: "Copy Claude Code command" })).toBeInTheDocument();
  });

  it("copies exactly the command text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithProviders(
      <ClaudeCodeCommand template="discover" params={{ target_token: "tgt_abc" }} />,
    );

    await user.click(screen.getByRole("button", { name: "Copy Claude Code command" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith("/tessa:discover tgt_abc"),
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("explains on focus that it runs the same prompt through the plugin", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClaudeCodeCommand template="mutants" />);

    await user.tab();

    expect(screen.getByRole("group", { name: "Claude Code command" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(CLAUDE_CODE_COMMAND_HINT);
  });

  it("shows the bare author command and the coverage hint above the cell cap", () => {
    const ids = Array.from({ length: MAX_AUTHOR_CELL_IDS + 1 }, (_, index) => `c${index}`);
    renderWithProviders(<ClaudeCodeCommand template="author" params={{ cell_ids: ids }} />);

    expect(screen.getByText("/tessa:author")).toBeInTheDocument();
    expect(screen.getByText(/coverage selection/)).toBeInTheDocument();
  });
});
