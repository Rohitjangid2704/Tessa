"use client";

import { FileText, LoaderCircle, TriangleAlert, Wrench } from "lucide-react";
import { useId, useState } from "react";
import { DateTime } from "@/components/date-time";
import { PromptCopyBox } from "@/components/prompt-copy-box";
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
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { describePromptIssueError, useIssuePrompt, type PromptIssue } from "@/features/prompts";
import { isApiError } from "@/lib/api/errors";
import { useIdempotencyKey } from "@/lib/api/idempotency";

export interface FixupPromptDialogProps {
  targetId: string;
  bundleId: string;
  bundleVersion: number;
  primary: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
}

export function FixupPromptDialog({
  targetId,
  bundleId,
  bundleVersion,
  primary,
  disabled = false,
  disabledReason = null,
}: FixupPromptDialogProps) {
  const reasonId = useId();
  const issuing = useIssuePrompt(targetId);
  const idempotency = useIdempotencyKey();
  const [issued, setIssued] = useState<PromptIssue | null>(null);
  const [open, setOpen] = useState(false);

  function generate(): void {
    issuing.mutate(
      {
        params: { template_name: "fixup", bundle_id: bundleId },
        idempotencyKey: idempotency.key,
      },
      {
        onSuccess: (created) => {
          setIssued(created);
          idempotency.rotate();
          setOpen(true);
        },
      },
    );
  }

  const blocked = disabled || disabledReason !== null;

  return (
    <div data-slot="fixup-prompt" className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant={primary ? "default" : "outline"}
        disabled={blocked || issuing.isPending}
        aria-busy={issuing.isPending}
        aria-describedby={disabledReason === null ? undefined : reasonId}
        onClick={issued === null ? generate : () => setOpen(true)}
      >
        {issuing.isPending ? (
          <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
        ) : (
          <Wrench aria-hidden="true" data-icon="inline-start" />
        )}
        {issuing.isPending
          ? "Generating"
          : issued === null
            ? "Generate Fix-up prompt"
            : "Show Fix-up prompt"}
      </Button>
      {disabledReason === null ? null : (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {disabledReason}
        </p>
      )}
      {issuing.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not generate the Fix-up prompt</AlertTitle>
          <AlertDescription>
            <p>{describePromptIssueError(issuing.error)}</p>
            {isApiError(issuing.error) && issuing.error.requestId ? (
              <p className="font-mono text-xs">Request ID: {issuing.error.requestId}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Fix-up prompt for version {bundleVersion}</DialogTitle>
            <DialogDescription>
              Paste it into Claude Code in the repository of this target. It lists what is open on
              this version: errors first, then the checks that lost points, then warnings. Zip the
              tessa folder again afterwards and upload it as the next version.
            </DialogDescription>
          </DialogHeader>
          {issued === null ? null : (
            <div className="flex flex-col gap-3">
              <PromptCopyBox
                text={issued.text}
                label="Fix-up prompt text"
                subject="Fix-up prompt"
                actions={
                  <ClaudeCodeCommand
                    template="discover"
                    params={{ target_token: issued.target_token }}
                  />
                }
              />
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
            <Button type="button" variant="outline" disabled={issuing.isPending} onClick={generate}>
              {issuing.isPending ? "Generating" : "Generate again"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
