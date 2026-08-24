"use client";

import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { PromptCopyBox } from "@/components/prompt-copy-box";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  describePromptIssueError,
  TemplateViewerDialog,
  type PromptIssue,
} from "@/features/prompts";

export type PromptResultProps = {
  issue: PromptIssue;
  label: string;
  subject: string;
  actions?: ReactNode;
};

export function PromptResult({ issue, label, subject, actions }: PromptResultProps) {
  return (
    <div data-slot="prompt-result" className="flex flex-col gap-4 border-t pt-4">
      <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Template</dt>
          <dd className="flex items-center gap-1">
            {issue.template_name} v{issue.template_version}
            <TemplateViewerDialog name={issue.template_name} version={issue.template_version} />
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Target token</dt>
          <dd className="flex items-center gap-1">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {issue.target_token}
            </code>
            <CopyButton
              text={issue.target_token}
              subject="target token"
              variant="ghost"
              size="xs"
            />
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Issued</dt>
          <dd>
            <DateTime value={issue.issued_at} />
          </dd>
        </div>
      </dl>
      <PromptCopyBox text={issue.text} label={label} subject={subject} actions={actions} />
    </div>
  );
}

export type PromptErrorProps = {
  title: string;
  error: unknown;
};

export function PromptError({ title, error }: PromptErrorProps) {
  const requestId = readRequestId(error);
  return (
    <Alert variant="destructive" data-slot="prompt-error">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{describePromptIssueError(error)}</p>
        {requestId === null ? null : <p className="font-mono text-xs">Request ID: {requestId}</p>}
      </AlertDescription>
    </Alert>
  );
}
