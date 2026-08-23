"use client";

import { useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { closeFindingSheet } from "../detail-url";
import { FindingDetail } from "./finding-detail";

export interface FindingSheetProps {
  findingId: string;
}

export function FindingSheet({ findingId }: FindingSheetProps) {
  const origin = useRef<HTMLElement | null>(null);

  function handleOpenChange(next: boolean): void {
    if (!next) {
      closeFindingSheet();
    }
  }

  function rememberOrigin(): void {
    const active = document.activeElement;
    origin.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  function restoreFocus(event: Event): void {
    event.preventDefault();
    const remembered = origin.current;
    if (remembered !== null && remembered.isConnected) {
      remembered.focus();
    }
  }

  return (
    <Sheet open onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        onOpenAutoFocus={rememberOrigin}
        onCloseAutoFocus={restoreFocus}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Finding details</SheetTitle>
          <SheetDescription>
            The overview, repro, occurrences and explanations of this finding.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8">
          <FindingDetail key={findingId} findingId={findingId} variant="sheet" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
