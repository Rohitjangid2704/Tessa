"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { runRoutes } from "@/lib/routes";
import { StepInspector } from "./step-inspector";

export interface StepDrawerProps {
  runId: string;
  stepId: string;
}

function findStepRow(runId: string, stepId: string): HTMLElement | null {
  const expected = runRoutes.step(runId, stepId);
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  return anchors.find((anchor) => anchor.getAttribute("href") === expected) ?? null;
}

export function StepDrawer({ runId, stepId }: StepDrawerProps) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const origin = useRef<HTMLElement | null>(null);

  function handleOpenChange(next: boolean): void {
    if (next || !open) {
      return;
    }
    setOpen(false);
    router.back();
  }

  function rememberOrigin(): void {
    const active = document.activeElement;
    origin.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  function restoreFocus(event: Event): void {
    event.preventDefault();
    const remembered = origin.current;
    const target =
      remembered !== null && remembered.isConnected ? remembered : findStepRow(runId, stepId);
    target?.focus();
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        onOpenAutoFocus={rememberOrigin}
        onCloseAutoFocus={restoreFocus}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Step details</SheetTitle>
          <SheetDescription>
            The request, response, screenshots and checks recorded for this step.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8">
          <StepInspector key={stepId} stepId={stepId} runId={runId} variant="drawer" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
