"use client";

import Link from "next/link";
import { useId } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { settingsRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useChecklistState } from "../use-checklist-state";

export const COMPRESS_ARCHIVE_COMMAND =
  "Compress-Archive -Path .\\tessa -DestinationPath .\\tessa.zip -Force";

export type PasteChecklistProps = {
  issueId: string;
  className?: string;
};

export function PasteChecklist({ issueId, className }: PasteChecklistProps) {
  const headingId = useId();
  const checklist = useChecklistState(issueId);

  return (
    <section
      aria-labelledby={headingId}
      data-slot="paste-checklist"
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          Paste checklist
        </h3>
        <div className="flex items-center gap-2">
          <p role="status" className="text-xs text-muted-foreground">
            {checklist.completedCount} of {checklist.total} steps done
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={checklist.completedCount === 0}
            onClick={checklist.reset}
          >
            Reset
          </Button>
        </div>
      </div>
      <p data-slot="claude-code-alternative" className="text-sm text-muted-foreground">
        or{" "}
        <Link
          href={settingsRoutes.tokens()}
          className="font-medium text-foreground underline underline-offset-4"
        >
          run it in Claude Code
        </Link>{" "}
        with the Tessa plugin instead of pasting.
      </p>
      <ul className="flex flex-col gap-2">
        {checklist.steps.map((step) => {
          const checkboxId = `${headingId}-${step.id}`;
          return (
            <li key={step.id} className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={checklist.isDone(step.id)}
                onCheckedChange={(checked) => checklist.setDone(step.id, checked === true)}
              />
              <Label
                htmlFor={checkboxId}
                className={cn(
                  "font-normal",
                  checklist.isDone(step.id) && "text-muted-foreground line-through",
                )}
              >
                {step.label}
              </Label>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
        <p className="text-xs text-muted-foreground">
          To zip the folder on Windows, run this in PowerShell from the project root:
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            tabIndex={0}
            aria-label="PowerShell command"
            className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background px-2 py-1.5"
          >
            <code className="font-mono text-xs whitespace-nowrap">{COMPRESS_ARCHIVE_COMMAND}</code>
          </div>
          <CopyButton text={COMPRESS_ARCHIVE_COMMAND} subject="zip command" size="sm" />
        </div>
      </div>
    </section>
  );
}
