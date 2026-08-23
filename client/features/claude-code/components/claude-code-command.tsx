"use client";

import { Terminal } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  useClaudeCodeCommand,
  type ClaudeCodeParams,
  type ClaudeCodeTemplate,
} from "../use-claude-code-command";

export const CLAUDE_CODE_COMMAND_HINT = "runs the same prompt through the plugin";

export type ClaudeCodeCommandProps = {
  [Template in ClaudeCodeTemplate]: {
    template: Template;
    params?: ClaudeCodeParams[Template];
  };
}[ClaudeCodeTemplate] & { className?: string };

export function ClaudeCodeCommand({ template, params, className }: ClaudeCodeCommandProps) {
  const { command, note } = useClaudeCodeCommand(template, params);

  return (
    <div
      data-slot="claude-code-command"
      data-template={template}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              role="group"
              tabIndex={0}
              aria-label="Claude Code command"
              className="flex max-w-80 min-w-0 items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2"
            >
              <Terminal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <code title={command} className="min-w-0 truncate font-mono text-xs">
                {command}
              </code>
              <CopyButton text={command} subject="Claude Code command" variant="ghost" size="xs" />
            </div>
          </TooltipTrigger>
          <TooltipContent>{CLAUDE_CODE_COMMAND_HINT}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {note === null ? null : <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
