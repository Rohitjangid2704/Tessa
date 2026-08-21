"use client";

import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import Link from "next/link";
import { EmptyState, type EmptyStateProps } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TargetSelect } from "@/features/targets/components/target-select";
import { useSwitchTarget } from "@/features/targets/current-target";
import { targetOptionsQuery } from "@/features/targets/queries";
import { describeApiError } from "@/lib/api/errors";
import { useCan } from "@/lib/auth/can";
import { targetRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";

export type TargetRequiredProps = Pick<EmptyStateProps, "className"> & {
  title?: string;
  description?: string;
};

export function TargetRequired({
  title = "Choose a target",
  description = "This page works on one target at a time. Pick one to continue.",
  className,
}: TargetRequiredProps) {
  const hydrated = useHydrated();
  const options = useQuery(targetOptionsQuery());
  const switchTarget = useSwitchTarget();
  const canCreate = useCan("targets.create");

  if (hydrated && options.isError) {
    return (
      <ErrorState
        title="Could not load targets"
        description={describeApiError(options.error)}
        requestId={readRequestId(options.error)}
        onRetry={() => void options.refetch()}
        className={className}
      />
    );
  }

  const targets = hydrated ? options.data : undefined;
  if (targets === undefined) {
    return (
      <EmptyState
        title={title}
        description={description}
        icon={Target}
        className={className}
        action={<Skeleton aria-hidden="true" className="h-8 w-56" />}
        aria-busy="true"
      />
    );
  }

  if (targets.length === 0) {
    return (
      <EmptyState
        title="No targets yet"
        description="Create a target first, then come back to pick it here."
        icon={Target}
        className={className}
        action={
          canCreate ? (
            <Button asChild>
              <Link href={targetRoutes.create()}>New target</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <EmptyState
      title={title}
      description={description}
      icon={Target}
      className={className}
      action={
        <TargetSelect
          value={null}
          onChange={switchTarget}
          options={targets.map((summary) => ({
            id: summary.id,
            name: summary.name,
            tier: summary.tier,
          }))}
          label="Choose a target"
        />
      }
    />
  );
}
