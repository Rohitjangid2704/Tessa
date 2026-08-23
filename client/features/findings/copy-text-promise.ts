export type TextPromiseCopyOutcome = "copied" | "unsupported" | "rejected";

function supportsPromisedClipboardItem(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

export function copyTextPromise(textPromise: Promise<string>): Promise<TextPromiseCopyOutcome> {
  if (!supportsPromisedClipboardItem()) {
    return textPromise.then(
      (): TextPromiseCopyOutcome => "unsupported",
      (): TextPromiseCopyOutcome => "rejected",
    );
  }
  const blobPromise = textPromise.then((text) => new Blob([text], { type: "text/plain" }));
  return navigator.clipboard.write([new ClipboardItem({ "text/plain": blobPromise })]).then(
    (): TextPromiseCopyOutcome => "copied",
    (): TextPromiseCopyOutcome => "rejected",
  );
}
