"use client";

import { FileText, LoaderCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { PromptCopyBox } from "@/components/prompt-copy-box";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { pluralize } from "@/features/bundles/format";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { describePromptIssueError } from "@/features/prompts";
import { formatBytes } from "@/lib/format-bytes";
import { targetRoutes } from "@/lib/routes";
import { AUTHOR_PROMPT_WARN_BYTES } from "../schemas";
import type { AuthorPromptController } from "../use-author-prompt";

export interface AuthorPromptDialogProps {
  targetId: string;
  prompt: AuthorPromptController;
}

export function promptByteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function AuthorPromptDialog({ targetId, prompt }: AuthorPromptDialogProps) {
  const { issued, isPending, error, cellCount, cellIds, itemIds } = prompt;
  const requestId = readRequestId(error);
  const bytes = issued === null ? 0 : promptByteSize(issued.text);
  const oversized = bytes > AUTHOR_PROMPT_WARN_BYTES;

  return (
    <Dialog open={prompt.open} onOpenChange={prompt.setOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Author prompt for {pluralize(cellCount, "cell")}</DialogTitle>
          <DialogDescription>
            Paste it into Claude Code in the repository of this target. It writes one scenario file
            per cell under tessa/scenarios/. Zip the tessa folder again and upload it as the
            next bundle version: the scenarios land in the review queue.
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Generating the Author prompt</span>
            <Skeleton aria-hidden="true" className="h-6 w-1/3" />
            <Skeleton aria-hidden="true" className="h-72 w-full" />
          </div>
        ) : null}
        {error !== null && !isPending ? (
          <Alert variant="destructive" data-slot="author-prompt-error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Could not generate the Author prompt</AlertTitle>
            <AlertDescription>
              <p>{describePromptIssueError(error)}</p>
              {requestId === null ? null : (
                <p className="font-mono text-xs">Request ID: {requestId}</p>
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        {issued === null ? null : (
          <div className="flex flex-col gap-3">
            <PromptCopyBox
              text={issued.text}
              label="Author prompt text"
              subject="Author prompt"
              actions={
                <ClaudeCodeCommand
                  template="author"
                  params={itemIds.length > 0 ? { item_ids: itemIds } : { cell_ids: cellIds }}
                />
              }
            />
            <p data-slot="author-prompt-size" className="text-sm">
              Size: <span className="font-medium tabular-nums">{formatBytes(bytes)}</span> (
              {bytes.toLocaleString("en-US")} bytes)
            </p>
            {oversized ? (
              <Alert data-slot="author-prompt-warning">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>This prompt is large</AlertTitle>
                <AlertDescription>
                  It is above {formatBytes(AUTHOR_PROMPT_WARN_BYTES)}, so an IDE chat box may cut
                  it off. Close this dialog, select fewer cells and copy the prompt again.
                </AlertDescription>
              </Alert>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <FileText aria-hidden="true" className="size-3.5" />
                Template {issued.template_name} version {issued.template_version}
              </span>
              <span>
                Issued <DateTime value={issued.issued_at} />
              </span>
              <span>
                Target token <code className="font-mono">{issued.target_token}</code>
              </span>
            </p>
          </div>
        )}
        <DialogFooter showCloseButton>
          <Button asChild variant="outline">
            <Link href={targetRoutes.bundles(targetId)}>Upload the bundle</Link>
          </Button>
          <Button type="button" variant="outline" disabled={isPending} onClick={prompt.regenerate}>
            {isPending ? (
              <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
            ) : null}
            {isPending ? "Generating" : error === null ? "Generate again" : "Try again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
