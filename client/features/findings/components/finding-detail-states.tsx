import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { findingRoutes } from "@/lib/routes";

export type FindingDetailVariant = "sheet" | "page";

export function BackToFindings({ targetId }: { targetId?: string | null }) {
  return (
    <Button asChild variant="outline" size="sm" className="self-start">
      <Link
        href={
          targetId === undefined || targetId === null
            ? findingRoutes.list()
            : findingRoutes.list({ target_id: targetId })
        }
      >
        <ArrowLeft aria-hidden="true" data-icon="inline-start" />
        Back to findings
      </Link>
    </Button>
  );
}

export function FindingDetailSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="finding-detail-skeleton"
      className="flex flex-col gap-6"
    >
      <span className="sr-only">Loading the finding</span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-2/3 max-w-full" />
        <Skeleton className="h-5 w-72 max-w-full" />
        <Skeleton className="h-8 w-80 max-w-full" />
      </div>
      <Skeleton className="h-9 w-full max-w-md" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export interface FindingStateProps {
  variant: FindingDetailVariant;
  error?: unknown;
  onRetry?: () => void;
}

export function FindingNotFound({ variant, error }: FindingStateProps) {
  return (
    <ErrorState
      title="Finding not found"
      description="This finding does not exist or was removed. Check the link, or go back to the board."
      requestId={readRequestId(error)}
      action={variant === "page" ? <BackToFindings /> : undefined}
    />
  );
}

export function FindingForbidden({ variant, error }: FindingStateProps) {
  return (
    <ErrorState
      title="You cannot open this finding"
      description="Your account is not allowed to read it. Ask an admin for access."
      requestId={readRequestId(error)}
      action={variant === "page" ? <BackToFindings /> : undefined}
    />
  );
}

export function FindingLoadError({ variant, error, onRetry }: FindingStateProps) {
  return (
    <ErrorState
      title="Could not load the finding"
      description={describeApiError(error)}
      requestId={readRequestId(error)}
      onRetry={onRetry}
      action={variant === "page" ? <BackToFindings /> : undefined}
    />
  );
}
