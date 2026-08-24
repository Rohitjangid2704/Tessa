"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { ScenarioProvenance } from "@/lib/api/types";
import { coverageRoutes, findingRoutes, replayRoutes, targetRoutes } from "@/lib/routes";
import { safeHttpUrl } from "@/lib/safe-http-url";
import { useHydrated } from "@/lib/use-hydrated";
import { scenarioProvenanceQuery } from "../queries";
import { DryRunList } from "./dry-run-list";

const SHORT_ID_LENGTH = 8;

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

function None() {
  return <span className="text-muted-foreground">None</span>;
}

function IdWithCopy({ id, subject }: { id: string; subject: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-xs">{id.slice(0, SHORT_ID_LENGTH)}</code>
      <CopyButton text={id} subject={subject} variant="ghost" size="xs" />
    </span>
  );
}

function TicketLink({ url }: { url: string }) {
  const safe = safeHttpUrl(url);
  if (safe === null) {
    return <code className="font-mono text-xs">{url}</code>;
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-4 hover:underline"
    >
      {new URL(safe).host}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function ProvenanceBody({
  provenance,
  targetId,
}: {
  provenance: ScenarioProvenance;
  targetId: string;
}) {
  const { generator } = provenance;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Item label="Cell">
          {provenance.cell_id === null ? (
            <None />
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2">
              <IdWithCopy id={provenance.cell_id} subject="cell id" />
              <Link
                href={coverageRoutes.map(targetId)}
                className="text-xs underline-offset-4 hover:underline"
              >
                Open coverage
              </Link>
            </span>
          )}
        </Item>
        <Item label="Bundle version">
          <Link
            href={targetRoutes.bundle(targetId, provenance.bundle_id)}
            className="underline-offset-4 hover:underline"
          >
            Bundle v{provenance.bundle_version}
          </Link>
        </Item>
        <Item label="Finding">
          {provenance.finding_id === null ? (
            <None />
          ) : (
            <Link
              href={findingRoutes.detail(provenance.finding_id)}
              className="font-mono text-xs underline-offset-4 hover:underline"
            >
              {provenance.finding_id.slice(0, SHORT_ID_LENGTH)}
            </Link>
          )}
        </Item>
        <Item label="Ticket">
          {provenance.ticket_url === null ? <None /> : <TicketLink url={provenance.ticket_url} />}
        </Item>
        <Item label="Prompt issue">
          {provenance.prompt_issue_id === null ? (
            <None />
          ) : (
            <IdWithCopy id={provenance.prompt_issue_id} subject="prompt issue id" />
          )}
        </Item>
        <Item label="Replay">
          {provenance.replay_id === null ? (
            <None />
          ) : (
            <Link
              href={replayRoutes.detail(provenance.replay_id)}
              className="font-mono text-xs underline-offset-4 hover:underline"
            >
              {provenance.replay_id.slice(0, SHORT_ID_LENGTH)}
            </Link>
          )}
        </Item>
        <Item label="Generator">
          {generator === null ? (
            <None />
          ) : (
            <span>
              <code className="font-mono text-xs">{generator.model}</code>, {generator.effort}{" "}
              effort, template v{generator.template_version}
            </span>
          )}
        </Item>
        <Item label="Recorded">
          <DateTime value={provenance.created_at} />
        </Item>
      </dl>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Dry runs</h3>
        <DryRunList dryRuns={provenance.dry_runs} />
      </div>
    </div>
  );
}

function ProvenanceSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading provenance</span>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

export type ProvenancePanelProps = {
  scenarioId: string;
  targetId: string;
  className?: string;
};

export function ProvenancePanel({ scenarioId, targetId, className }: ProvenancePanelProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const query = useQuery(scenarioProvenanceQuery(scenarioId));

  let body: ReactNode;
  if (!hydrated || query.isPending) {
    body = <ProvenanceSkeleton />;
  } else if (query.data === undefined) {
    body = (
      <ErrorState
        title="Could not load the provenance"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
        className="py-8"
      />
    );
  } else {
    body = <ProvenanceBody provenance={query.data} targetId={targetId} />;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="provenance-panel"
      className={className ?? "flex flex-col gap-3"}
    >
      <h2 id={headingId} className="text-base font-semibold">
        Provenance
      </h2>
      {body}
    </section>
  );
}
