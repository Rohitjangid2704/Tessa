"use client";

import { CopyButton } from "@/components/copy-button";
import { apiBaseUrl } from "@/lib/api/client";

export const SERVICE_KEY_HEADER = "X-Service-Key";
export const SERVICE_KEY_PLACEHOLDER = "$TESSA_SERVICE_KEY";
export const SCHEDULE_ID_PLACEHOLDER = "<schedule-id>";

export function buildRunNowCommand(apiUrl: string, scheduleId: string | null): string {
  const target = `${apiUrl}/api/v1/schedules/${scheduleId ?? SCHEDULE_ID_PLACEHOLDER}/run-now`;
  return [
    `curl -X POST "${target}"`,
    `  -H "${SERVICE_KEY_HEADER}: ${SERVICE_KEY_PLACEHOLDER}"`,
    `  -H "Idempotency-Key: $(uuidgen)"`,
  ].join(" \\\n");
}

export interface RunNowSnippetProps {
  scheduleId: string | null;
}

export function RunNowSnippet({ scheduleId }: RunNowSnippetProps) {
  const command = buildRunNowCommand(apiBaseUrl, scheduleId);
  const unsavedNote =
    scheduleId === null ? ` The schedule id replaces ${SCHEDULE_ID_PLACEHOLDER} once saved.` : "";
  return (
    <div
      data-slot="run-now-snippet"
      className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Run it from CI</p>
        <CopyButton text={command} subject="the run-now command" size="sm" />
      </div>
      <p className="text-xs text-muted-foreground">
        The commit tier has no clock. Call run-now from your pipeline after each commit, with the
        service key kept in your CI secret store as {SERVICE_KEY_PLACEHOLDER}. Never commit the key.
        {unsavedNote}
      </p>
      <div role="region" aria-label="Run-now command" tabIndex={0} className="overflow-x-auto">
        <pre className="rounded-md bg-background p-3 font-mono text-xs leading-relaxed">
          <code>{command}</code>
        </pre>
      </div>
    </div>
  );
}
