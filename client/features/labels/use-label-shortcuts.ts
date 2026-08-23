import { useEffect, useEffectEvent } from "react";
import type { LabelValue } from "@/lib/api/types";

export type ShortcutAction =
  | { kind: "answer"; value: LabelValue }
  | { kind: "skip" }
  | { kind: "open" }
  | { kind: "undo" }
  | { kind: "help" };

export const SHORTCUT_KEYS = {
  pass: "p",
  fail: "f",
  uncertain: "u",
  skip: "s",
  open: "o",
  undo: "z",
  help: "?",
} as const;

const ACTION_BY_KEY: ReadonlyMap<string, ShortcutAction> = new Map<string, ShortcutAction>([
  [SHORTCUT_KEYS.pass, { kind: "answer", value: "pass" }],
  [SHORTCUT_KEYS.fail, { kind: "answer", value: "fail" }],
  [SHORTCUT_KEYS.uncertain, { kind: "answer", value: "uncertain" }],
  [SHORTCUT_KEYS.skip, { kind: "skip" }],
  [SHORTCUT_KEYS.open, { kind: "open" }],
  [SHORTCUT_KEYS.undo, { kind: "undo" }],
  [SHORTCUT_KEYS.help, { kind: "help" }],
]);

const IGNORED_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(",");

export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(IGNORED_TARGET_SELECTOR) !== null;
}

export function resolveShortcut(event: ShortcutEventLike): ShortcutAction | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    isTypingTarget(event.target)
  ) {
    return null;
  }
  if (event.key === SHORTCUT_KEYS.help) {
    return ACTION_BY_KEY.get(SHORTCUT_KEYS.help) ?? null;
  }
  if (event.shiftKey) {
    return null;
  }
  return ACTION_BY_KEY.get(event.key.toLowerCase()) ?? null;
}

export function useLabelShortcuts(
  onAction: (action: ShortcutAction) => void,
  enabled: boolean,
): void {
  const handleAction = useEffectEvent(onAction);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    function listen(event: KeyboardEvent): void {
      const action = resolveShortcut(event);
      if (action !== null) {
        event.preventDefault();
        handleAction(action);
      }
    }
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, [enabled]);
}
