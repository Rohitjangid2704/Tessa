"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { describeApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import { healthQuery } from "../queries";
import { DependenciesCard } from "./dependencies-card";
import { LivenessCard } from "./liveness-card";
import { SchemasCard } from "./schemas-card";

export function SettingsDiagnostics() {
  const queryClient = useQueryClient();
  const health = useQuery(healthQuery());

  if (health.isError) {
    return (
      <ErrorState
        title="The API is not reachable"
        description={describeApiError(health.error)}
        requestId={readRequestId(health.error)}
        retryLabel={health.isFetching ? "Retrying" : "Retry"}
        onRetry={() => void queryClient.refetchQueries({ queryKey: qk.system.all() })}
      />
    );
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <LivenessCard />
      <DependenciesCard />
      <SchemasCard />
    </div>
  );
}
