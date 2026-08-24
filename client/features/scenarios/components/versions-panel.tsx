"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { CodeView } from "@/components/code-view";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { DiffView } from "@/components/diff-view";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { ScenarioVersion } from "@/lib/api/types";
import { useHydrated } from "@/lib/use-hydrated";
import { scenarioVersionsQuery } from "../queries";

type VersionView = "yaml" | "changes";

type VersionDialogProps = {
  version: ScenarioVersion | null;
  currentYaml: string;
  currentVersion: number;
  canRestore: boolean;
  onRestore: (version: ScenarioVersion) => void;
  onClose: () => void;
};

function VersionDialog({
  version,
  currentYaml,
  currentVersion,
  canRestore,
  onRestore,
  onClose,
}: VersionDialogProps) {
  const [view, setView] = useState<VersionView>("yaml");
  const isCurrent = version?.version === currentVersion;

  return (
    <Dialog open={version !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{version === null ? "Version" : `Version ${version.version}`}</DialogTitle>
          <DialogDescription>
            Read-only. Restoring puts this YAML into the editor as an unsaved change.
          </DialogDescription>
        </DialogHeader>
        {version === null ? null : (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="View">
              <Button
                type="button"
                size="sm"
                variant={view === "yaml" ? "secondary" : "outline"}
                aria-pressed={view === "yaml"}
                onClick={() => setView("yaml")}
              >
                YAML
              </Button>
              <Button
                type="button"
                size="sm"
                variant={view === "changes" ? "secondary" : "outline"}
                aria-pressed={view === "changes"}
                disabled={isCurrent}
                onClick={() => setView("changes")}
              >
                Changes since this version
              </Button>
            </div>
            {view === "changes" && !isCurrent ? (
              <DiffView
                original={version.yaml}
                modified={currentYaml}
                originalLabel={`Version ${version.version}`}
                modifiedLabel={`Version ${currentVersion}, current`}
                label={`Changes from version ${version.version} to the current version`}
              />
            ) : (
              <CodeView
                value={version.yaml}
                language="yaml"
                label={`YAML of version ${version.version}, read-only`}
              />
            )}
          </div>
        )}
        <DialogFooter>
          {version === null ? null : (
            <CopyButton text={version.yaml} subject={`YAML of version ${version.version}`} />
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!canRestore || version === null || isCurrent}
            onClick={() => (version === null ? undefined : onRestore(version))}
          >
            Restore into the editor
          </Button>
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type VersionsPanelProps = {
  scenarioId: string;
  currentVersion: number;
  currentYaml: string;
  canRestore: boolean;
  onRestore: (version: ScenarioVersion) => void;
};

export function VersionsPanel({
  scenarioId,
  currentVersion,
  currentYaml,
  canRestore,
  onRestore,
}: VersionsPanelProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const query = useQuery(scenarioVersionsQuery(scenarioId));
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const opened = query.data?.find((item) => item.version === openVersion) ?? null;

  let body: ReactNode;
  if (!hydrated || query.isPending) {
    body = (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading versions</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (query.data === undefined) {
    body = (
      <ErrorState
        title="Could not load the versions"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
        className="py-8"
      />
    );
  } else {
    body = (
      <ol aria-label="Versions" className="flex flex-col gap-1.5">
        {query.data.map((item) => (
          <li
            key={item.version}
            data-version={item.version}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                Version {item.version}
                {item.version === currentVersion ? <Badge variant="secondary">Current</Badge> : null}
              </span>
              <span className="text-xs text-muted-foreground">
                <DateTime value={item.created_at} />
              </span>
              {item.note === null ? null : (
                <span className="text-xs wrap-break-word text-muted-foreground">{item.note}</span>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpenVersion(item.version)}>
              Open
              <span className="sr-only"> version {item.version}, read-only</span>
            </Button>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <section aria-labelledby={headingId} data-slot="versions-panel" className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        Versions
      </h2>
      {body}
      <VersionDialog
        key={opened?.version ?? "none"}
        version={opened}
        currentYaml={currentYaml}
        currentVersion={currentVersion}
        canRestore={canRestore}
        onRestore={(version) => {
          setOpenVersion(null);
          onRestore(version);
        }}
        onClose={() => setOpenVersion(null)}
      />
    </section>
  );
}
