"use client";

import { Sparkles, TriangleAlert, Wrench } from "lucide-react";
import { useId } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import type { Target } from "@/features/targets/types";
import { useCanDo } from "@/lib/auth/can";
import type { BundleHookMissing } from "../types";
import { usePromptCard } from "../use-prompt-card";
import { PromptError, PromptResult } from "./prompt-result";

export type HooksPromptCardProps = {
  target: Pick<Target, "id" | "name" | "archived_at">;
  bundleId: string;
  bundleVersion: number;
  hooks: readonly BundleHookMissing[];
  className?: string;
};

export function HooksPromptCard({
  target,
  bundleId,
  bundleVersion,
  hooks,
  className,
}: HooksPromptCardProps) {
  const headingId = useId();
  const issueAccess = useCanDo("prompts.issue");
  const prompt = usePromptCard(target.id);

  if (hooks.length === 0) {
    return null;
  }

  const archived = target.archived_at !== null && target.archived_at !== undefined;
  const blockedReason = archived
    ? "This target is archived, so it cannot issue new prompts."
    : !issueAccess.isPending && !issueAccess.allowed
      ? "You can read prompts, but issuing one needs the member or admin role."
      : null;
  const generateDisabled = blockedReason !== null || issueAccess.isPending || prompt.isPending;

  return (
    <Card data-slot="hooks-prompt-card" aria-labelledby={headingId} className={className}>
      <CardHeader>
        <CardTitle id={headingId} role="heading" aria-level={2}>
          Hooks prompt
        </CardTitle>
        <CardDescription>
          Version {bundleVersion} of the bundle lists test hooks the app does not have yet. Mutation
          runs and seeds are more reliable once they exist. Paste the prompt into Claude Code in the
          repository of {target.name}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {blockedReason === null ? null : (
          <Alert role="status">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}
        <ul aria-label="Missing test hooks" className="flex flex-col gap-2">
          {hooks.map((hook) => (
            <li
              key={hook.id}
              data-hook-id={hook.id}
              className="flex items-start gap-2 rounded-lg border p-2 text-sm"
            >
              <Wrench aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-xs font-medium">{hook.id}</span>
                <span className="text-muted-foreground">{hook.description}</span>
              </span>
            </li>
          ))}
        </ul>
        {prompt.error === null || prompt.error === undefined ? null : (
          <PromptError title="Could not generate the Hooks prompt" error={prompt.error} />
        )}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            disabled={generateDisabled}
            onClick={() => prompt.generate({ template_name: "hooks", bundle_id: bundleId })}
          >
            <Sparkles aria-hidden="true" data-icon="inline-start" />
            {prompt.isPending
              ? "Generating"
              : prompt.issued === null
                ? "Generate Hooks prompt"
                : "Generate again"}
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {prompt.isPending ? "Generating the prompt" : ""}
          </p>
        </div>
        {prompt.issued === null ? null : (
          <PromptResult
            issue={prompt.issued}
            label="Hooks prompt"
            subject="Hooks prompt"
            actions={<ClaudeCodeCommand template="hooks" />}
          />
        )}
      </CardContent>
    </Card>
  );
}
