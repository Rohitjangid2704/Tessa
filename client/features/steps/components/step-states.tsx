import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { runRoutes } from "@/lib/routes";

export type StepInspectorVariant = "drawer" | "page";

export function BackToRun({ runId }: { runId: string | undefined }) {
  return (
    <Button asChild variant="outline" size="sm" className="self-start">
      <Link href={runId === undefined ? runRoutes.list() : runRoutes.detail(runId)}>
        <ArrowLeft aria-hidden="true" data-icon="inline-start" />
        {runId === undefined ? "Back to runs" : "Back to run"}
      </Link>
    </Button>
  );
}

export function StepSkeleton() {
  return (
    <div role="status" aria-busy="true" data-slot="step-skeleton" className="flex flex-col gap-6">
      <span className="sr-only">Loading the step</span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-2/3 max-w-full" />
        <Skeleton className="h-5 w-48 max-w-full" />
        <Skeleton className="h-10 w-full max-w-md" />
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

export interface StepNotFoundProps {
  runId: string | undefined;
  variant: StepInspectorVariant;
  requestId?: string | null;
}

export function StepNotFound({ runId, variant, requestId = null }: StepNotFoundProps) {
  return (
    <ErrorState
      title="Step not found"
      description="This step does not exist, it does not belong to this run, or it was removed."
      requestId={requestId}
      action={variant === "page" ? <BackToRun runId={runId} /> : undefined}
    />
  );
}

export interface StepLoadErrorProps {
  error: unknown;
  runId: string | undefined;
  variant: StepInspectorVariant;
  onRetry: () => void;
}

export function StepLoadError({ error, runId, variant, onRetry }: StepLoadErrorProps) {
  return (
    <ErrorState
      title="Could not load the step"
      description={describeApiError(error)}
      requestId={readRequestId(error)}
      onRetry={onRetry}
      action={variant === "page" ? <BackToRun runId={runId} /> : undefined}
    />
  );
}
