"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { PromptCopyBox } from "@/components/prompt-copy-box";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { appKindsQuery } from "@/features/targets/queries";
import type { AppKindHint, Target } from "@/features/targets/types";
import { useIdempotencyKey } from "@/lib/api/idempotency";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import { describePromptIssueError, isUnknownHintError } from "../errors";
import { useIssuePrompt } from "../mutations";
import type { PromptIssue } from "../types";
import { PasteChecklist } from "./paste-checklist";
import { TemplateViewerDialog } from "./template-viewer-dialog";

export type DiscoveryPromptPanelProps = {
  target: Pick<Target, "id" | "name" | "app_kind" | "archived_at" | "target_token">;
  initialIssue?: PromptIssue | null;
  onIssued?: (issue: PromptIssue) => void;
  className?: string;
};

export function initialHintSelection(
  hints: readonly AppKindHint[],
  issue: PromptIssue | null,
): ReadonlySet<string> {
  const issuedIds: unknown = issue?.params.hint_ids;
  if (issue?.template_name === "discovery" && Array.isArray(issuedIds)) {
    const known = new Set(hints.map((hint) => hint.id));
    return new Set(issuedIds.filter((id): id is string => typeof id === "string" && known.has(id)));
  }
  return new Set(hints.filter((hint) => hint.default_on).map((hint) => hint.id));
}

export function DiscoveryPromptPanel({
  target,
  initialIssue = null,
  onIssued,
  className,
}: DiscoveryPromptPanelProps) {
  const hydrated = useHydrated();
  const issueAccess = useCanDo("prompts.issue");
  const rolePending = !hydrated || issueAccess.isPending;
  const archived = target.archived_at != null;
  const appKinds = useQuery(appKindsQuery());
  const issuing = useIssuePrompt(target.id);
  const idempotency = useIdempotencyKey();
  const [issued, setIssued] = useState<PromptIssue | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);

  const appKindsPending = !hydrated || appKinds.isPending;
  const appKindsFailed = hydrated && appKinds.isError;
  const hints = hydrated
    ? (appKinds.data?.items.find((option) => option.kind === target.app_kind)?.hints ?? [])
    : [];
  const selection = picked ?? initialHintSelection(hints, initialIssue);
  const shown = issued ?? initialIssue;
  const tokenRotated = shown !== null && shown.target_token !== target.target_token;
  const roleBlocked = !rolePending && !issueAccess.allowed;
  const blockedReason = archived
    ? "This target is archived, so it cannot issue new prompts."
    : roleBlocked
      ? "You can read prompts, but issuing one needs the member or admin role."
      : null;

  function toggleHint(hintId: string, checked: boolean): void {
    const next = new Set(selection);
    if (checked) {
      next.add(hintId);
    } else {
      next.delete(hintId);
    }
    setPicked(next);
    idempotency.rotate();
  }

  function generate(): void {
    issuing.mutate(
      {
        params: {
          template_name: "discovery",
          hint_ids: hints.filter((hint) => selection.has(hint.id)).map((hint) => hint.id),
        },
        idempotencyKey: idempotency.key,
      },
      {
        onSuccess: (created) => {
          setIssued(created);
          idempotency.rotate();
          onIssued?.(created);
        },
      },
    );
  }

  const generateDisabled =
    blockedReason !== null || rolePending || appKindsPending || appKindsFailed || issuing.isPending;

  return (
    <Card data-slot="discovery-prompt-panel" className={className}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Discovery prompt
        </CardTitle>
        <CardDescription>
          Paste it into Claude Code in the repository of {target.name}. It writes a Tessa/
          folder that you upload on the Bundles tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {blockedReason !== null ? (
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        ) : null}

        {appKindsPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Loading the app-kind hints</span>
            <Skeleton className="h-5 w-72 max-w-full" />
            <Skeleton className="h-5 w-64 max-w-full" />
          </div>
        ) : appKindsFailed ? (
          <ErrorState
            title="Could not load the app-kind hints"
            description={describeApiError(appKinds.error)}
            requestId={readRequestId(appKinds.error)}
            onRetry={() => void appKinds.refetch()}
            className="py-6"
          />
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">App-kind hints</legend>
            {hints.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There are no extra hints for this app kind.
              </p>
            ) : null}
            {hints.map((hint) => {
              const inputId = `hint-${target.id}-${hint.id}`;
              return (
                <div key={hint.id} className="flex items-center gap-2">
                  <Checkbox
                    id={inputId}
                    checked={selection.has(hint.id)}
                    disabled={blockedReason !== null}
                    onCheckedChange={(checked) => toggleHint(hint.id, checked === true)}
                  />
                  <Label htmlFor={inputId} className="font-normal">
                    {hint.label}
                  </Label>
                </div>
              );
            })}
          </fieldset>
        )}

        {issuing.isError ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Could not generate the prompt</AlertTitle>
            <AlertDescription>
              <p>{describePromptIssueError(issuing.error)}</p>
              {isApiError(issuing.error) && issuing.error.requestId ? (
                <p className="font-mono text-xs">Request ID: {issuing.error.requestId}</p>
              ) : null}
              {isUnknownHintError(issuing.error) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setPicked(null);
                    issuing.reset();
                    void appKinds.refetch();
                  }}
                >
                  Reload hints
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="button" disabled={generateDisabled} onClick={generate}>
            <Sparkles aria-hidden="true" data-icon="inline-start" />
            {issuing.isPending
              ? "Generating"
              : shown === null
                ? "Generate Discovery prompt"
                : "Generate again"}
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {issuing.isPending ? "Generating the prompt" : ""}
          </p>
        </div>

        {shown !== null ? (
          <div className="flex flex-col gap-4 border-t pt-4">
            <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Template</dt>
                <dd className="flex items-center gap-1">
                  Discovery v{shown.template_version}
                  <TemplateViewerDialog
                    name={shown.template_name}
                    version={shown.template_version}
                  />
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Target token</dt>
                <dd className="flex items-center gap-1">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {shown.target_token}
                  </code>
                  <CopyButton
                    text={shown.target_token}
                    subject="target token"
                    variant="ghost"
                    size="xs"
                  />
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Issued</dt>
                <dd>
                  <DateTime value={shown.issued_at} />
                </dd>
              </div>
            </dl>
            {tokenRotated ? (
              <Alert>
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>
                  The target token was rotated after this prompt was issued. Uploads made with the
                  old token still match until the next rotation; generate again to use the new one.
                </AlertDescription>
              </Alert>
            ) : null}
            <PromptCopyBox
              text={shown.text}
              label="Discovery prompt"
              actions={
                <ClaudeCodeCommand
                  template="discover"
                  params={{ target_token: shown.target_token }}
                />
              }
            />
            <PasteChecklist issueId={shown.id} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
