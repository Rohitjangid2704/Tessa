"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { INVARIANT_PACK_LABELS, INVARIANT_PACKS } from "@/features/invariants/labels";
import { invariantCatalogQuery } from "@/features/invariants/queries";
import type { Target } from "@/features/targets/types";
import { describeApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { MUTANTS_PROMPT_ANCHOR } from "../schemas";
import { usePromptCard } from "../use-prompt-card";
import { PromptError, PromptResult } from "./prompt-result";

export type MutantsPromptCardProps = {
  target: Pick<Target, "id" | "name" | "archived_at">;
  className?: string;
};

export function MutantsPromptCard({ target, className }: MutantsPromptCardProps) {
  const headingId = useId();
  const issueAccess = useCanDo("prompts.issue");
  const catalog = useQuery(invariantCatalogQuery());
  const prompt = usePromptCard(target.id);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);

  const invariants = useMemo(() => catalog.data ?? [], [catalog.data]);
  const selection = picked ?? new Set(invariants.map((invariant) => invariant.id));
  const archived = target.archived_at !== null && target.archived_at !== undefined;
  const blockedReason = archived
    ? "This target is archived, so it cannot issue new prompts."
    : !issueAccess.isPending && !issueAccess.allowed
      ? "You can read prompts, but issuing one needs the member or admin role."
      : null;
  const chosenIds = invariants.filter((invariant) => selection.has(invariant.id)).map((i) => i.id);
  const generateDisabled =
    blockedReason !== null ||
    issueAccess.isPending ||
    catalog.isPending ||
    catalog.isError ||
    chosenIds.length === 0 ||
    prompt.isPending;

  function toggle(invariantId: string, checked: boolean): void {
    const next = new Set(selection);
    if (checked) {
      next.add(invariantId);
    } else {
      next.delete(invariantId);
    }
    setPicked(next);
  }

  function generate(): void {
    prompt.generate({ template_name: "mutants", invariant_ids: chosenIds });
  }

  return (
    <Card
      id={MUTANTS_PROMPT_ANCHOR}
      data-slot="mutants-prompt-card"
      aria-labelledby={headingId}
      className={className}
    >
      <CardHeader>
        <CardTitle id={headingId} role="heading" aria-level={2}>
          Mutants prompt
        </CardTitle>
        <CardDescription>
          Paste it into Claude Code in the repository of {target.name}. It creates one branch per
          bug, each breaking the invariants you pick below, and writes tessa/mutants.yaml.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {blockedReason === null ? null : (
          <Alert role="status">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}
        {catalog.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Loading the invariants</span>
            <Skeleton className="h-5 w-72 max-w-full" />
            <Skeleton className="h-5 w-64 max-w-full" />
            <Skeleton className="h-5 w-56 max-w-full" />
          </div>
        ) : catalog.isError ? (
          <ErrorState
            title="Could not load the invariants"
            description={describeApiError(catalog.error)}
            requestId={readRequestId(catalog.error)}
            onRetry={() => void catalog.refetch()}
            className="py-6"
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                Invariants to break ({chosenIds.length} of {invariants.length})
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={blockedReason !== null}
                  onClick={() => setPicked(new Set(invariants.map((invariant) => invariant.id)))}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={blockedReason !== null}
                  onClick={() => setPicked(new Set())}
                >
                  Select none
                </Button>
              </div>
            </div>
            {INVARIANT_PACKS.map((pack) => {
              const inPack = invariants.filter((invariant) => invariant.pack === pack);
              if (inPack.length === 0) {
                return null;
              }
              return (
                <fieldset key={pack} className="flex flex-col gap-2">
                  <legend className="mb-1 text-xs font-medium text-muted-foreground">
                    {INVARIANT_PACK_LABELS[pack]}
                  </legend>
                  {inPack.map((invariant) => {
                    const inputId = `${headingId}-${invariant.id}`;
                    return (
                      <div key={invariant.id} className="flex items-start gap-2">
                        <Checkbox
                          id={inputId}
                          checked={selection.has(invariant.id)}
                          disabled={blockedReason !== null}
                          onCheckedChange={(checked) => toggle(invariant.id, checked === true)}
                          className="mt-0.5"
                        />
                        <Label
                          htmlFor={inputId}
                          className="flex flex-col items-start gap-0 font-normal"
                        >
                          <span>{invariant.title}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {invariant.id}
                          </span>
                        </Label>
                      </div>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
        )}
        {prompt.error === null || prompt.error === undefined ? null : (
          <PromptError title="Could not generate the Mutants prompt" error={prompt.error} />
        )}
        <div className="flex items-center gap-3">
          <Button type="button" disabled={generateDisabled} onClick={generate}>
            <Sparkles aria-hidden="true" data-icon="inline-start" />
            {prompt.isPending
              ? "Generating"
              : prompt.issued === null
                ? "Generate Mutants prompt"
                : "Generate again"}
          </Button>
          {!catalog.isPending && !catalog.isError && chosenIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">Pick at least one invariant.</p>
          ) : null}
          <p role="status" className="text-sm text-muted-foreground">
            {prompt.isPending ? "Generating the prompt" : ""}
          </p>
        </div>
        {prompt.issued === null ? null : (
          <PromptResult
            issue={prompt.issued}
            label="Mutants prompt"
            subject="Mutants prompt"
            actions={<ClaudeCodeCommand template="mutants" />}
          />
        )}
      </CardContent>
    </Card>
  );
}
