"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DateTime } from "@/components/date-time";
import { PromptCopyBox } from "@/components/prompt-copy-box";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { promptTemplateQuery, promptTemplatesQuery } from "../queries";
import type { PromptTemplateName } from "../types";

export type TemplateViewerDialogProps = {
  name: PromptTemplateName;
  version?: number;
  trigger?: ReactNode;
};

export function templateTitle(name: PromptTemplateName): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} template`;
}

function TemplateViewerBody({
  name,
  initialVersion,
}: {
  name: PromptTemplateName;
  initialVersion: number | undefined;
}) {
  const [chosenVersion, setChosenVersion] = useState<number | undefined>(initialVersion);
  const template = useQuery(promptTemplateQuery(name, chosenVersion));
  const all = useQuery(promptTemplatesQuery());

  const versions = (all.data ?? [])
    .filter((candidate) => candidate.name === name)
    .map((candidate) => candidate.version)
    .sort((left, right) => right - left);
  const latest = versions[0];

  if (template.isError) {
    return (
      <ErrorState
        title="Could not load the template"
        description={describeApiError(template.error)}
        requestId={readRequestId(template.error)}
        onRetry={() => void template.refetch()}
        className="py-8"
      />
    );
  }

  if (template.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading the template</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const shown = template.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {versions.length > 1 ? (
          <Select
            value={String(shown.version)}
            onValueChange={(value) => setChosenVersion(Number(value))}
          >
            <SelectTrigger aria-label="Template version" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {versions.map((version) => (
                <SelectItem key={version} value={String(version)}>
                  {version === latest ? `Version ${version} (latest)` : `Version ${version}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="secondary">Version {shown.version}</Badge>
        )}
        <p className="text-sm text-muted-foreground">
          Created <DateTime value={shown.created_at} />
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">Variables filled in when a prompt is issued</h3>
        {shown.variables.length === 0 ? (
          <p className="text-sm text-muted-foreground">This template has no variables.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {shown.variables.map((variable) => (
              <li key={variable}>
                <Badge variant="outline" className="font-mono">
                  {`{{${variable}}}`}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      <PromptCopyBox
        text={shown.text}
        label="Template text"
        subject="template text"
        textClassName="h-80"
      />
    </div>
  );
}

export function TemplateViewerDialog({ name, version, trigger }: TemplateViewerDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="ghost" size="sm">
            <FileText aria-hidden="true" data-icon="inline-start" />
            {version === undefined ? "View template" : `View template v${version}`}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{templateTitle(name)}</DialogTitle>
          <DialogDescription>
            The text Tessa fills in to build a prompt. Read-only; prompts already issued never
            change when a template does.
          </DialogDescription>
        </DialogHeader>
        <TemplateViewerBody name={name} initialVersion={version} />
      </DialogContent>
    </Dialog>
  );
}
