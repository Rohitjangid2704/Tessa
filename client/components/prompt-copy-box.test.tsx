import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_FEEDBACK_MS } from "./copy-button";
import { PromptCopyBox, countLines } from "./prompt-copy-box";

const PROMPT = ["You are preparing this repository.", "", "target_token tgt_abc", "line 4"].join(
  "\n",
);

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

function setExecCommand(implementation: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(document, "execCommand", {
    value: implementation,
    configurable: true,
    writable: true,
  });
}

async function clickCopy(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  setClipboard(undefined);
  setExecCommand(undefined);
});

describe("PromptCopyBox", () => {
  it("shows the whole prompt as read-only text with its size", () => {
    render(<PromptCopyBox text={PROMPT} label="Discovery prompt" />);

    const area = screen.getByRole("textbox", { name: "Discovery prompt" });
    expect(area).toHaveValue(PROMPT);
    expect(area).toHaveAttribute("readonly");
    expect(screen.getByText(`4 lines, ${PROMPT.length} characters`)).toBeInTheDocument();
  });

  it("copies the full text with the clipboard API and says Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<PromptCopyBox text={PROMPT} />);

    await clickCopy();

    expect(writeText).toHaveBeenCalledExactlyOnceWith(PROMPT);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByText("Copied to clipboard")).toBeInTheDocument();
  });

  it("announces the result in a polite live region", async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    render(<PromptCopyBox text={PROMPT} />);
    const live = screen.getByRole("status", { name: "" });
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toBeEmptyDOMElement();

    await clickCopy();

    expect(live).toHaveTextContent("Copied to clipboard");
  });

  it("returns to Copy after a moment", async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    render(<PromptCopyBox text={PROMPT} />);
    await clickCopy();
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS + 50);
    });

    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toBeEmptyDOMElement();
  });

  it("copies through the hidden textarea fallback when the clipboard is denied", async () => {
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new DOMException("no", "NotAllowedError")),
    });
    let copied = "";
    setExecCommand(() => {
      copied =
        document.querySelector<HTMLTextAreaElement>("textarea[aria-hidden=true]")?.value ?? "";
      return true;
    });
    render(<PromptCopyBox text={PROMPT} />);

    await clickCopy();

    expect(copied).toBe(PROMPT);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.queryByText(/blocked copying/)).not.toBeInTheDocument();
  });

  it("copies through the fallback when there is no clipboard API", async () => {
    setClipboard(undefined);
    setExecCommand(() => true);
    render(<PromptCopyBox text={PROMPT} />);

    await clickCopy();

    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("selects the text and tells the user to press Ctrl+C when every route fails", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    setExecCommand(() => false);
    render(<PromptCopyBox text={PROMPT} label="Discovery prompt" />);

    await clickCopy();

    expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument();
    expect(screen.getByText(/Your browser blocked copying/)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Copy failed. Select the text and press Ctrl+C",
    );
    const area = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Discovery prompt" });
    expect(area).toHaveFocus();
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(PROMPT.length);
  });

  it("clears the blocked message after a later copy works", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    setExecCommand(() => false);
    render(<PromptCopyBox text={PROMPT} />);
    await clickCopy();
    expect(screen.getByText(/Your browser blocked copying/)).toBeInTheDocument();

    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS + 50);
    });
    await clickCopy();

    expect(screen.queryByText(/Your browser blocked copying/)).not.toBeInTheDocument();
  });

  it("renders extra actions next to Copy", () => {
    render(<PromptCopyBox text={PROMPT} actions={<button type="button">Extra</button>} />);

    expect(screen.getByRole("button", { name: "Extra" })).toBeInTheDocument();
  });

  it("names the copy button after its subject", () => {
    render(<PromptCopyBox text={PROMPT} subject="Fix-up prompt" />);

    expect(screen.getByRole("button", { name: "Copy Fix-up prompt" })).toBeInTheDocument();
  });
});

describe("countLines", () => {
  it("counts lines of text and zero for nothing", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\ntwo\n")).toBe(3);
  });
});
