import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

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

afterEach(() => {
  setClipboard(undefined);
  setExecCommand(undefined);
  document.body.innerHTML = "";
});

describe("copyToClipboard", () => {
  it("writes with the async clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyToClipboard("hello")).resolves.toBe("clipboard");

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a hidden textarea when the clipboard permission is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    setClipboard({ writeText });
    let copiedValue = "";
    setExecCommand((command) => {
      const area = document.querySelector("textarea");
      copiedValue = area?.value ?? "";
      return command === "copy" && area !== null;
    });

    await expect(copyToClipboard("line one\nline two")).resolves.toBe("fallback");

    expect(writeText).toHaveBeenCalledOnce();
    expect(copiedValue).toBe("line one\nline two");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when the clipboard API does not exist, as on an insecure origin", async () => {
    setClipboard(undefined);
    setExecCommand(() => true);

    await expect(copyToClipboard("hello")).resolves.toBe("fallback");
  });

  it("keeps the hidden textarea out of the tab order and away from screen readers", async () => {
    setClipboard(undefined);
    let attributes: Record<string, string | null> = {};
    setExecCommand(() => {
      const area = document.querySelector("textarea");
      attributes = {
        readonly: area?.getAttribute("readonly") ?? null,
        hidden: area?.getAttribute("aria-hidden") ?? null,
        tabindex: area?.getAttribute("tabindex") ?? null,
      };
      return true;
    });

    await copyToClipboard("hello");

    expect(attributes).toEqual({ readonly: "", hidden: "true", tabindex: "-1" });
  });

  it("returns focus to the element that had it", async () => {
    setClipboard(undefined);
    setExecCommand(() => true);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();

    await copyToClipboard("hello");

    expect(document.activeElement).toBe(button);
  });

  it("reports failure when both routes fail", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    setExecCommand(() => false);

    await expect(copyToClipboard("hello")).resolves.toBe("failed");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when execCommand throws or is missing", async () => {
    setClipboard(undefined);
    setExecCommand(() => {
      throw new Error("not supported");
    });
    await expect(copyToClipboard("hello")).resolves.toBe("failed");

    setExecCommand(undefined);
    await expect(copyToClipboard("hello")).resolves.toBe("failed");
  });
});
