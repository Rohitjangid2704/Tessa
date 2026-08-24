import { useEffect, useEffectEvent } from "react";
import type { Hotkey } from "@/components/hotkey-hint";
import { isPlainShortcut, type KeyEventLike } from "@/lib/keyboard";

export type ReviewShortcut = "next" | "previous" | "accept" | "reject";

export const REVIEW_SHORTCUT_KEYS = {
  next: "j",
  previous: "k",
  accept: "a",
  reject: "r",
} as const satisfies Record<ReviewShortcut, string>;

export const REVIEW_HOTKEYS: readonly Hotkey[] = [
  { keys: [REVIEW_SHORTCUT_KEYS.next], action: "Select the next scenario" },
  { keys: [REVIEW_SHORTCUT_KEYS.previous], action: "Select the previous scenario" },
  { keys: [REVIEW_SHORTCUT_KEYS.accept], action: "Accept the selected scenario" },
  { keys: [REVIEW_SHORTCUT_KEYS.reject], action: "Reject the selected scenario, with a note" },
];

const SHORTCUT_BY_KEY: ReadonlyMap<string, ReviewShortcut> = new Map(
  (Object.keys(REVIEW_SHORTCUT_KEYS) as ReviewShortcut[]).map((shortcut) => [
    REVIEW_SHORTCUT_KEYS[shortcut],
    shortcut,
  ]),
);

export function resolveReviewShortcut(event: KeyEventLike): ReviewShortcut | null {
  if (event.shiftKey || !isPlainShortcut(event)) {
    return null;
  }
  return SHORTCUT_BY_KEY.get(event.key) ?? null;
}

export function useReviewShortcuts(
  onShortcut: (shortcut: ReviewShortcut) => void,
  enabled: boolean,
): void {
  const handleShortcut = useEffectEvent(onShortcut);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    function listen(event: KeyboardEvent): void {
      const shortcut = resolveReviewShortcut(event);
      if (shortcut !== null) {
        event.preventDefault();
        handleShortcut(shortcut);
      }
    }
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, [enabled]);
}
