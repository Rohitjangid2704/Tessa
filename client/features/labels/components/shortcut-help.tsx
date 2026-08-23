"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { SHORTCUT_KEYS } from "../use-label-shortcuts";

export const SHORTCUT_DESCRIPTIONS = [
  { key: SHORTCUT_KEYS.pass, action: "Label the card pass" },
  { key: SHORTCUT_KEYS.fail, action: "Label the card fail" },
  { key: SHORTCUT_KEYS.uncertain, action: "Label the card uncertain" },
  { key: SHORTCUT_KEYS.skip, action: "Skip the card, it comes back at the end" },
  { key: SHORTCUT_KEYS.open, action: "Open the step in a new tab" },
  { key: SHORTCUT_KEYS.undo, action: "Undo your last label and bring the card back" },
  { key: SHORTCUT_KEYS.help, action: "Show or hide this list" },
] as const;

export interface ShortcutHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutHelp({ open, onOpenChange }: ShortcutHelpProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single keys work while focus is not in a text field, and are ignored together with Ctrl,
            Alt or Cmd.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {SHORTCUT_DESCRIPTIONS.map((shortcut) => (
            <div key={shortcut.key} className="contents">
              <dt>
                <Kbd>{shortcut.key}</Kbd>
                <span className="sr-only"> key</span>
              </dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted-foreground">
          The machine verdict stays hidden until you answer, so it cannot sway yours. Audit and
          disagreement cards are always blind.
        </p>
      </DialogContent>
    </Dialog>
  );
}
