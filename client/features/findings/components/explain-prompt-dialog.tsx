"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { PromptCopyBox } from "@/components/prompt-copy-box";
import { RequiresPermission } from "@/components/requires-permission";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { TemplateViewerDialog } from "@/features/prompts/components/template-viewer-dialog";
import { describePromptIssueError } from "@/features/prompts/errors";
import type { PromptIssue } from "@/features/prompts/types";
import { createIdempotencyKey } from "@/lib/api/idempotency";
import { qk } from "@/lib/api/query-keys";
import type { Finding } from "@/lib/api/types";
import { formatBytes } from "@/lib/format-bytes";
import { copyTextPromise } from "../copy-text-promise";
import { useIssueExplainPrompt } from "../detail-mutations";
import { explainPromptQuery } from "../detail-queries";

export const LARGE_PROMPT_BYTES = 100 * 1024;
export const LARGE_PROMPT_PREVIEW_CHARACTERS = 100 * 1024;

export const EXPLAIN_CHECKLIST_STEPS = [
  { id: "open_vscode", label: "Open VS Code" },
  { id: "open_project", label: "Open the project folder of the app under test" },
  { id: "open_claude_code", label: "Open Claude Code in that window" },
  { id: "paste_prompt", label: "Paste the prompt and send it" },
  { id: "copy_answer", label: "Copy the answer and paste it under Explanations" },
] as const;

export type ExplainCopyState = "idle" | "copying" | "copied" | "manual";

const textEncoder = new TextEncoder();

export interface ExplainPromptDialogProps {
  finding: Pick<Finding, "id" | "target_id">;
  variant?: "default" | "outline";
}

function ExplainChecklist({ issueId }: { issueId: string }) {
  const headingId = useId();
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  function toggle(stepId: string, checked: boolean): void {
    const next = new Set(done);
    if (checked) {
      next.add(stepId);
    } else {
      next.delete(stepId);
    }
    setDone(next);
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="explain-checklist"
      data-issue-id={issueId}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          Paste checklist
        </h3>
        <p role="status" className="text-xs text-muted-foreground">
          {done.size} of {EXPLAIN_CHECKLIST_STEPS.length} steps done
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {EXPLAIN_CHECKLIST_STEPS.map((step) => {
          const checkboxId = `${headingId}-${step.id}`;
          const checked = done.has(step.id);
          return (
            <li key={step.id} className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={checked}
                onCheckedChange={(value) => toggle(step.id, value === true)}
              />
              <Label
                htmlFor={checkboxId}
                className={
                  checked ? "font-normal text-muted-foreground line-through" : "font-normal"
                }
              >
                {step.label}
              </Label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface ExplainPromptBodyProps {
  issue: PromptIssue;
  findingId: string;
  copyState: ExplainCopyState;
  onRegenerate: () => void;
  regenerating: boolean;
}

function ExplainPromptBody({
  issue,
  findingId,
  copyState,
  onRegenerate,
  regenerating,
}: ExplainPromptBodyProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [selectionBlocked, setSelectionBlocked] = useState(false);
  const bytes = useMemo(() => textEncoder.encode(issue.text).length, [issue.text]);
  const large = bytes > LARGE_PROMPT_BYTES;
  const preview = large ? issue.text.slice(0, LARGE_PROMPT_PREVIEW_CHARACTERS) : issue.text;
  const showCopyBox = copyState === "manual" && !large;
  const claudeCodeCommand = (
    <ClaudeCodeCommand template="explain" params={{ finding_id: findingId }} />
  );

  function handleCopyOutcome(outcome: "clipboard" | "fallback" | "failed"): void {
    setSelectionBlocked(outcome === "failed");
    if (outcome === "failed" && preRef.current !== null) {
      preRef.current.focus();
      window.getSelection()?.selectAllChildren(preRef.current);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Template</dt>
          <dd className="flex items-center gap-1">
            Explain v{issue.template_version}
            <TemplateViewerDialog name="explain" version={issue.template_version} />
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Size</dt>
          <dd>{formatBytes(bytes)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">Issued</dt>
          <dd>
            <DateTime value={issue.issued_at} />
          </dd>
        </div>
      </dl>
      {large ? (
        <Alert>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This prompt is over 100 KB</AlertTitle>
          <AlertDescription>
            It may be slow to paste. The preview below shows the first 100 KB; Copy still copies the
            whole prompt.
          </AlertDescription>
        </Alert>
      ) : null}
      {showCopyBox ? (
        <PromptCopyBox
          text={issue.text}
          label="Explain prompt"
          subject="Explain prompt"
          actions={claudeCodeCommand}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Explain prompt</span>
            <div className="flex items-center gap-2">
              {claudeCodeCommand}
              <CopyButton
                text={issue.text}
                subject="Explain prompt"
                onCopyOutcome={handleCopyOutcome}
              />
            </div>
          </div>
          <pre
            ref={preRef}
            role="region"
            aria-label="Explain prompt text"
            tabIndex={0}
            className="max-h-72 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap"
          >
            {preview}
          </pre>
          {selectionBlocked ? (
            <p role="alert" className="text-xs text-destructive">
              Your browser blocked copying. The text is selected: press Ctrl+C to copy it.
            </p>
          ) : null}
        </div>
      )}
      <ExplainChecklist key={issue.id} issueId={issue.id} />
      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={regenerating}
          onClick={onRegenerate}
        >
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Regenerate prompt
        </Button>
        <p className="text-xs text-muted-foreground">
          A regenerated prompt is a new issue; the earlier one stays in the prompt history.
        </p>
      </div>
    </div>
  );
}

function describeCopyState(state: ExplainCopyState): string {
  switch (state) {
    case "copying":
      return "Generating the prompt";
    case "copied":
      return "Copied to the clipboard. Paste it into Claude Code.";
    case "manual":
      return "Your browser did not copy it automatically. Press Copy below.";
    case "idle":
      return "";
  }
}

export function ExplainPromptDialog({ finding, variant = "outline" }: ExplainPromptDialogProps) {
  const queryClient = useQueryClient();
  const cached = useQuery(explainPromptQuery(finding.id));
  const issue = useIssueExplainPrompt(finding.target_id, finding.id);
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<ExplainCopyState>("idle");

  function startCopy(regenerate: boolean): void {
    const existing = regenerate
      ? undefined
      : queryClient.getQueryData<PromptIssue>(qk.promptIssues.explain(finding.id));
    const textPromise =
      existing === undefined
        ? issue
            .mutateAsync({ idempotencyKey: createIdempotencyKey() })
            .then((created) => created.text)
        : Promise.resolve(existing.text);
    setCopyState("copying");
    void copyTextPromise(textPromise).then((outcome) =>
      setCopyState(outcome === "copied" ? "copied" : "manual"),
    );
  }

  const shown = cached.data;
  const failed = issue.isError && !issue.isPending;
  const message = failed ? "" : describeCopyState(copyState);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <RequiresPermission action="findings.explain">
        {({ disabled }) => (
          <DialogTrigger asChild>
            <Button
              type="button"
              variant={variant}
              size="sm"
              disabled={disabled || issue.isPending}
              onClick={() => startCopy(false)}
            >
              <Sparkles aria-hidden="true" data-icon="inline-start" />
              Copy Explain prompt
            </Button>
          </DialogTrigger>
        )}
      </RequiresPermission>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Explain prompt</DialogTitle>
          <DialogDescription>
            Paste it into Claude Code in the repository of the app. It reads the code, names the
            root cause with path:line references and you paste the answer back here.
          </DialogDescription>
        </DialogHeader>
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {message}
        </p>
        {failed ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Could not generate the prompt</AlertTitle>
            <AlertDescription>
              <p>{describePromptIssueError(issue.error)}</p>
              {readRequestId(issue.error) === null ? null : (
                <p className="font-mono text-xs">Request ID: {readRequestId(issue.error)}</p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => startCopy(true)}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {shown === undefined && !failed ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-3">
            <span className="sr-only">Generating the Explain prompt</span>
            <Skeleton className="h-5 w-64 max-w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : null}
        {shown === undefined ? null : (
          <ExplainPromptBody
            issue={shown}
            findingId={finding.id}
            copyState={copyState}
            regenerating={issue.isPending}
            onRegenerate={() => startCopy(true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
