export type CopyOutcome = "clipboard" | "fallback" | "failed";

async function writeWithClipboardApi(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function writeWithHiddenTextarea(text: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  Object.assign(area.style, { position: "fixed", top: "0", left: "-9999px", opacity: "0" });
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  previouslyFocused?.focus();
  return copied;
}

export async function copyToClipboard(text: string): Promise<CopyOutcome> {
  if (await writeWithClipboardApi(text)) {
    return "clipboard";
  }
  return writeWithHiddenTextarea(text) ? "fallback" : "failed";
}
