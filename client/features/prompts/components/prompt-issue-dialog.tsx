"use client";

import { useQuery } from "@tanstack/react-query";
import { DateTime } from "@/components/date-time";
import { PromptCopyBox } from "@/components/prompt-copy-box";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { promptIssueQuery } from "../queries";
import type { PromptTemplateName } from "../types";
import { TemplateViewerDialog } from "./template-viewer-dialog";

export const TEMPLATE_LABELS: Record<PromptTemplateName, string> = {
  discovery: "Discovery",
  fixup: "Fix-up",
  explain: "Explain",
  author: "Author",
  hooks: "Hooks",
  mutants: "Mutants",
};

export type PromptIssueDialogProps = {
  issueId: string;
  templateName: PromptTemplateName;
  templateVersion: number;
};

function PromptIssueBody({ issueId }: { issueId: string }) {
  const issue = useQuery(promptIssueQuery(issueId));

  if (issue.isError) {
    return (
      <ErrorState
        title="Could not load the prompt"
        description={describeApiError(issue.error)}
        requestId={readRequestId(issue.error)}
        onRetry={() => void issue.refetch()}
        className="py-8"
      />
    );
  }
  if (issue.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading the prompt</span>
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const shown = issue.data;
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Template</dt>
          <dd className="flex items-center gap-1">
            {TEMPLATE_LABELS[shown.template_name]} v{shown.template_version}
            <TemplateViewerDialog name={shown.template_name} version={shown.template_version} />
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Target token</dt>
          <dd>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {shown.target_token}
            </code>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Issued</dt>
          <dd>
            <DateTime value={shown.issued_at} />
          </dd>
        </div>
      </dl>
      <PromptCopyBox
        text={shown.text}
        label={`${TEMPLATE_LABELS[shown.template_name]} prompt`}
        textClassName="h-80"
      />
    </div>
  );
}

export function PromptIssueDialog({
  issueId,
  templateName,
  templateVersion,
}: PromptIssueDialogProps) {
  const label = `${TEMPLATE_LABELS[templateName]} v${templateVersion}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          Open <span className="sr-only">{label} prompt</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{TEMPLATE_LABELS[templateName]} prompt</DialogTitle>
          <DialogDescription>
            The exact text issued, kept as it was even if the template or the token changed since.
          </DialogDescription>
        </DialogHeader>
        <PromptIssueBody issueId={issueId} />
      </DialogContent>
    </Dialog>
  );
}
