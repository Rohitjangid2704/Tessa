"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { CodeView } from "@/components/code-view";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { oracleTemplateQuery } from "../queries";
import { ApprovalBar } from "./approval-bar";
import { ApprovalBadge, LanguageBadge, ReadOnlyBadge } from "./oracle-badges";
import { ResultHistory } from "./result-history";
import { ResultView, useShownResult } from "./result-view";
import { RunPanel } from "./run-panel";

export interface TemplateDetailProps {
  templateId: string;
  resultId: string | null;
  onResultChange: (resultId: string) => void;
  onClose: () => void;
}

function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the template</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export function TemplateDetail({
  templateId,
  resultId,
  onResultChange,
  onClose,
}: TemplateDetailProps) {
  const templateQuery = useQuery(oracleTemplateQuery(templateId));
  const shown = useShownResult(resultId, templateId);
  const { result } = shown;
  const runAccess = useCanDo("oracle.run");
  const approveAccess = useCanDo("oracle.approve");

  if (templateQuery.isPending) {
    return <DetailSkeleton />;
  }

  if (templateQuery.isError) {
    const missing =
      isApiError(templateQuery.error) && [404, 422].includes(templateQuery.error.status);
    return (
      <ErrorState
        title={missing ? "Template not found" : "Could not load the template"}
        description={
          missing
            ? "This template does not exist any more. It may belong to an older bundle."
            : describeApiError(templateQuery.error)
        }
        requestId={readRequestId(templateQuery.error)}
        onRetry={missing ? undefined : () => void templateQuery.refetch()}
        action={
          missing ? (
            <Button variant="outline" onClick={onClose}>
              Back to the list
            </Button>
          ) : undefined
        }
      />
    );
  }

  const template = templateQuery.data;
  return (
    <article
      data-slot="template-detail"
      data-template-id={template.id}
      aria-labelledby={`template-${template.id}-name`}
      className="flex flex-col gap-6"
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id={`template-${template.id}-name`}
            className="font-mono text-lg font-semibold break-all"
          >
            {template.name}
          </h2>
          <LanguageBadge language={template.language} />
          <ApprovalBadge approval={template.approval} />
          <ReadOnlyBadge verified={template.read_only_verified} />
        </div>
        {template.feature_ids.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Gold values for{" "}
            {template.feature_ids.map((featureId, index) => (
              <span key={featureId}>
                {index > 0 ? ", " : ""}
                <span className="font-mono text-foreground">{featureId}</span>
              </span>
            ))}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Sentence template:{" "}
          <span className="font-mono text-foreground">{template.sentence_template}</span>
        </p>
      </header>

      {template.read_only_verified ? null : (
        <Alert data-slot="read-only-warning">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Not verified as read-only</AlertTitle>
          <AlertDescription>
            The bundle check could not prove that this query only reads data. You can still run it,
            but it cannot be approved or rejected until the query is fixed in the bundle.
          </AlertDescription>
        </Alert>
      )}

      <section aria-label="Source" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Source</h3>
        <CodeView
          value={template.source}
          language={template.language}
          label={`Source of ${template.name}`}
        />
      </section>

      <RunPanel
        key={template.id}
        template={template}
        canRun={runAccess.allowed}
        accessKnown={!runAccess.isPending}
        onResultStarted={onResultChange}
      />

      <section aria-label="Result" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Result</h3>
        <ResultView resultId={resultId} shown={shown} />
      </section>

      <ApprovalBar
        key={result?.id ?? "none"}
        template={template}
        result={result}
        canReview={approveAccess.allowed}
        accessKnown={!approveAccess.isPending}
      />

      <section aria-label="History" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Earlier runs</h3>
        <ResultHistory
          templateId={template.id}
          selectedResultId={resultId}
          onSelect={onResultChange}
        />
      </section>
    </article>
  );
}
