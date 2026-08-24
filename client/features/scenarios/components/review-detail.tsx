"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ExternalLink, LoaderCircle, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CodeView } from "@/components/code-view";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { ReviewDecision, ScenarioSummary } from "@/lib/api/types";
import { scenarioRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { SCENARIO_ORIGIN_LABELS } from "../labels";
import { isScenarioNotFound, scenarioQuery } from "../queries";
import { REVIEW_SHORTCUT_KEYS } from "../review-shortcuts";
import { ProvenancePanel } from "./provenance-panel";
import { ScenarioStatusBadge } from "./scenario-status-badge";
import { IssueAlerts } from "./validation-panel";

export type ReviewDetailProps = {
  summary: ScenarioSummary;
  canReview: boolean;
  pendingDecision: ReviewDecision | null;
  error: unknown;
  onAccept: () => void;
  onReject: () => void;
};

function ReviewDetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the scenario</span>
      <Skeleton className="h-6 w-72 max-w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function ReviewDetail({
  summary,
  canReview,
  pendingDecision,
  error,
  onAccept,
  onReject,
}: ReviewDetailProps) {
  const hydrated = useHydrated();
  const query = useQuery(scenarioQuery(summary.id));
  const busy = pendingDecision !== null;
  const scenario = query.data;
  const stillInReview = scenario === undefined || scenario.status === "in_review";

  let yamlBlock: ReactNode;
  if (!hydrated || query.isPending) {
    yamlBlock = <ReviewDetailSkeleton />;
  } else if (scenario === undefined) {
    const notFound = isScenarioNotFound(query.error);
    yamlBlock = (
      <ErrorState
        title={notFound ? "Scenario not found" : "Could not load the scenario"}
        description={
          notFound
            ? "This scenario was removed. The queue refreshes without it."
            : describeApiError(query.error)
        }
        requestId={readRequestId(query.error)}
        onRetry={notFound ? undefined : () => void query.refetch()}
        className="py-10"
      />
    );
  } else {
    yamlBlock = (
      <div className="flex flex-col gap-4">
        <IssueAlerts
          errors={scenario.validation.errors}
          warnings={scenario.validation.warnings}
          yaml={scenario.yaml}
        />
        <CodeView value={scenario.yaml} language="yaml" label={`YAML of ${scenario.title}, read-only`} />
      </div>
    );
  }

  return (
    <article
      data-slot="review-detail"
      data-scenario-id={summary.id}
      className="flex min-w-0 flex-col gap-5"
    >
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight wrap-break-word">
            {summary.title}
          </h2>
          <ScenarioStatusBadge status={scenario?.status ?? summary.status} />
          <Badge variant="outline">{SCENARIO_ORIGIN_LABELS[summary.origin]}</Badge>
          <Badge variant="outline">v{summary.version}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>
            Family <code className="font-mono text-xs">{summary.family}</code>
          </span>
          {summary.feature_id === null ? null : (
            <span>
              Feature <code className="font-mono text-xs">{summary.feature_id}</code>
            </span>
          )}
          <Link
            href={scenarioRoutes.detail(summary.id)}
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            Open in the editor
            <ExternalLink aria-hidden="true" className="size-3" />
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Review decision">
          <Button
            type="button"
            disabled={!canReview || busy || !stillInReview}
            aria-busy={pendingDecision === "accept"}
            aria-keyshortcuts={REVIEW_SHORTCUT_KEYS.accept}
            onClick={onAccept}
          >
            {pendingDecision === "accept" ? (
              <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
            ) : (
              <Check aria-hidden="true" data-icon="inline-start" />
            )}
            Accept
            <Kbd aria-hidden="true">{REVIEW_SHORTCUT_KEYS.accept}</Kbd>
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!canReview || busy || !stillInReview}
            aria-keyshortcuts={REVIEW_SHORTCUT_KEYS.reject}
            onClick={onReject}
          >
            <X aria-hidden="true" data-icon="inline-start" />
            Reject
            <Kbd aria-hidden="true">{REVIEW_SHORTCUT_KEYS.reject}</Kbd>
          </Button>
          {canReview ? null : (
            <span className="text-sm text-muted-foreground">
              Viewers can read the queue but cannot accept or reject.
            </span>
          )}
        </div>
        {error === null || error === undefined ? null : (
          <Alert variant="destructive" role="alert" data-slot="review-error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>The decision was not saved</AlertTitle>
            <AlertDescription>
              {describeApiError(error)}
              {readRequestId(error) === null ? null : (
                <span className="block font-mono text-xs">Request ID: {readRequestId(error)}</span>
              )}
            </AlertDescription>
          </Alert>
        )}
      </header>
      {yamlBlock}
      <ProvenancePanel scenarioId={summary.id} targetId={summary.target_id} />
    </article>
  );
}
