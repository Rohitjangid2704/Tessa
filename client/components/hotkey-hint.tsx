"use client";

import { Keyboard } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { isPlainShortcut } from "@/lib/keyboard";

export const HOTKEY_HELP_KEY = "?";

export type Hotkey = {
  keys: readonly string[];
  action: string;
};

export type HotkeyHintProps = {
  hotkeys: readonly Hotkey[];
  title?: string;
  description?: string;
  enabled?: boolean;
  className?: string;
};

export function HotkeyHint({
  hotkeys,
  title = "Keyboard shortcuts",
  description = "Single keys work while focus is not in a text field or a dialog, and are ignored together with Ctrl, Alt or Cmd.",
  enabled = true,
  className,
}: HotkeyHintProps) {
  const [open, setOpen] = useState(false);
  const toggle = useEffectEvent(() => setOpen((current) => !current));

  useEffect(() => {
    if (!enabled) {
      return;
    }
    function listen(event: KeyboardEvent): void {
      if (event.key === HOTKEY_HELP_KEY && isPlainShortcut(event)) {
        event.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, [enabled]);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Keyboard aria-hidden="true" data-icon="inline-start" />
        Shortcuts
        <Kbd aria-hidden="true">{HOTKEY_HELP_KEY}</Kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            {hotkeys.map((hotkey) => (
              <div key={hotkey.keys.join("+")} className="contents">
                <dt className="flex items-center gap-1">
                  {hotkey.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                  <span className="sr-only"> key</span>
                </dt>
                <dd>{hotkey.action}</dd>
              </div>
            ))}
            <div className="contents">
              <dt>
                <Kbd>{HOTKEY_HELP_KEY}</Kbd>
                <span className="sr-only"> key</span>
              </dt>
              <dd>Show this list</dd>
            </div>
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
