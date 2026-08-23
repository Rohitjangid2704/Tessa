"use client";

import { ClipboardCopy, Sparkles } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { describeSkipReason } from "@/features/runs/skip-reasons";
import { scenarioRoutes } from "@/lib/routes";
import {
  authorBlockedReason,
  generateBlockedReason,
  type CoverageAccess,
} from "../access";
import { CELL_STATUS_DESCRIPTIONS } from "../labels";
import { proposalItemIdsOf } from "../selection";
import type { CoverageCell } from "../types";
import { CellProposalItems } from "./cell-proposal-items";
import { CellScenarios } from "./cell-scenarios";
import { CellStatusBadge, LastVerdictMark } from "./cell-status";

export interface CellSheetProps {
  targetId: string;
  cell: CoverageCell | null;
  featureTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  access: CoverageAccess;
  onGenerate: (cell: CoverageCell) => void;
  onAuthor: (cell: CoverageCell) => void;
}

function CellReason({ cell }: { cell: CoverageCell }) {
  if (cell.status === "needs_author") {
    return (
      <section data-slot="cell-reason" className="flex flex-col gap-1 text-sm">
        <h3 className="font-medium">Why this needs an author</h3>
        <p>{cell.reason ?? "Tessa cannot write this scenario from the bundle examples."}</p>
      </section>
    );
  }
  if (cell.status === "blocked") {
    const skipReason = cell.skip_reason;
    return (
      <section data-slot="cell-reason" className="flex flex-col gap-1 text-sm">
        <h3 className="font-medium">Why this is blocked</h3>
        {skipReason === null ? null : (
          <p>
            Skip reason: <span className="font-mono">{skipReason}</span> (
            {describeSkipReason(skipReason).label})
          </p>
        )}
        {cell.reason === null ? null : <p>{cell.reason}</p>}
      </section>
    );
  }
  return null;
}

function ActionNote({ id, reason }: { id: string; reason: string | null }) {
  return reason === null ? null : (
    <p id={id} className="text-xs text-muted-foreground">
      {reason}
    </p>
  );
}

function CellActions({
  cell,
  access,
  onGenerate,
  onAuthor,
}: Pick<CellSheetProps, "access" | "onGenerate" | "onAuthor"> & { cell: CoverageCell }) {
  const noteId = useId();
  const generateReason = generateBlockedReason(access);
  const authorReason = authorBlockedReason(access);
  const describedBy = (reason: string | null) => (reason === null ? undefined : noteId);

  if (cell.status === "empty") {
    return (
      <div className="flex flex-col gap-2" data-slot="cell-actions">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={generateReason !== null}
            aria-describedby={describedBy(generateReason)}
            onClick={() => onGenerate(cell)}
          >
            <Sparkles aria-hidden="true" data-icon="inline-start" />
            Generate here
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={authorReason !== null}
            aria-describedby={describedBy(authorReason)}
            onClick={() => onAuthor(cell)}
          >
            <ClipboardCopy aria-hidden="true" data-icon="inline-start" />
            Copy Author prompt
          </Button>
        </div>
        <ActionNote id={noteId} reason={generateReason ?? authorReason} />
      </div>
    );
  }
  if (cell.status === "needs_author") {
    return (
      <div className="flex flex-col gap-2" data-slot="cell-actions">
        <div>
          <Button
            type="button"
            disabled={authorReason !== null}
            aria-describedby={describedBy(authorReason)}
            onClick={() => onAuthor(cell)}
          >
            <ClipboardCopy aria-hidden="true" data-icon="inline-start" />
            Copy Author prompt
          </Button>
        </div>
        <ActionNote id={noteId} reason={authorReason} />
      </div>
    );
  }
  if (cell.status === "generated") {
    return (
      <div data-slot="cell-actions">
        <Button asChild variant="outline">
          <Link href={scenarioRoutes.review()}>Open the review queue</Link>
        </Button>
      </div>
    );
  }
  return null;
}

export function CellSheet({
  targetId,
  cell,
  featureTitle,
  open,
  onOpenChange,
  access,
  onGenerate,
  onAuthor,
}: CellSheetProps) {
  return (
    <Sheet open={open && cell !== null} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 overflow-y-auto sm:max-w-md" data-slot="cell-sheet">
        {cell === null ? null : (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle>{featureTitle}</SheetTitle>
              <SheetDescription>
                {cell.role} on {cell.interface_id}
                <span className="block font-mono text-xs">{cell.feature_id}</span>
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 px-4 pb-6">
              <div className="flex flex-wrap items-center gap-2">
                <CellStatusBadge status={cell.status} />
                <LastVerdictMark verdict={cell.last_verdict} />
                <span className="text-xs text-muted-foreground">
                  {CELL_STATUS_DESCRIPTIONS[cell.status]}
                </span>
              </div>
              <CellReason cell={cell} />
              <CellActions
                cell={cell}
                access={access}
                onGenerate={onGenerate}
                onAuthor={onAuthor}
              />
              <CellProposalItems
                key={`proposal:${cell.id}`}
                targetId={targetId}
                itemIds={proposalItemIdsOf(cell)}
              />
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Scenarios</h3>
                <CellScenarios key={cell.id} targetId={targetId} cellId={cell.id} />
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
