"use client";

import { useQuery } from "@tanstack/react-query";
import { Archive, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { isTargetNotFound, targetQuery } from "../queries";
import type { Target } from "../types";
import { TargetHeader } from "./target-header";
import { TargetTabs } from "./target-tabs";

export type TargetFrameProps = {
  targetId: string;
  children: ReactNode;
};

function ProductionBanner({ target }: { target: Target }) {
  return (
    <Alert variant="destructive" role="status" data-slot="production-banner">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>Production target</AlertTitle>
      <AlertDescription>
        {target.allow_production
          ? "Runs against this target are allowed and stay read-only: write features are skipped."
          : "Runs against this target are blocked until an admin allows production. Even then they stay read-only."}
      </AlertDescription>
    </Alert>
  );
}

function ArchivedBanner() {
  return (
    <Alert role="status" data-slot="archived-banner">
      <Archive aria-hidden="true" />
      <AlertTitle>This target is archived</AlertTitle>
      <AlertDescription>
        It stays readable, but it can no longer issue prompts, take uploads or be edited.
      </AlertDescription>
    </Alert>
  );
}

export function TargetFrame({ targetId, children }: TargetFrameProps) {
  const hydrated = useHydrated();
  const query = useQuery(targetQuery(targetId));

  if (hydrated && query.isError) {
    const notFound = isTargetNotFound(query.error);
    return (
      <ErrorState
        title={notFound ? "Target not found" : "Could not load the target"}
        description={
          notFound
            ? "This target does not exist or was removed. Pick another one from the targets list."
            : describeApiError(query.error)
        }
        requestId={readRequestId(query.error)}
        onRetry={notFound ? undefined : () => void query.refetch()}
        action={
          <Button asChild variant="outline">
            <Link href={targetRoutes.list()}>Back to targets</Link>
          </Button>
        }
      />
    );
  }

  const target = hydrated ? query.data : undefined;
  return (
    <div className="flex flex-col gap-6">
      <TargetHeader target={target} />
      <TargetTabs targetId={targetId} />
      {target?.archived_at ? <ArchivedBanner /> : null}
      {target?.tier === "production" ? <ProductionBanner target={target} /> : null}
      <div>{children}</div>
    </div>
  );
}
